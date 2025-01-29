require('dotenv').config();
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const morgan = require('morgan');

const app = express();
app.use(express.json());
app.use(morgan('dev'));
app.use('/logs', express.static('logs'));

const checkWebhookConfig = (req, res, next) => {
    const configuredWebhook = process.env.DISCORD_WEBHOOK_URL;
    if (!configuredWebhook) {
        console.error('DISCORD_WEBHOOK_URL environment variable is not set');
        res.status(500).json({ error: 'Discord webhook URL is not configured' });
        return;
    }
    next();
};

async function exportLog(webhookRequest) {
    const now = new Date();
    const filename = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}.${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}.log`;
    
    await fs.mkdir('logs', { recursive: true }); // Ensure logs directory exists
    await fs.writeFile(path.join('logs', filename), webhookRequest.messageContent);
    return filename;
}

async function cleanupOldLogs() {
    const retentionDays = parseInt(process.env.LOG_RETENTION_DAYS || '3');
    const logsDir = 'logs';
    
    try {
        // Get all files in the logs directory
        const files = await fs.readdir(logsDir);
        const now = new Date();
        
        for (const file of files) {
            const filePath = path.join(logsDir, file);
            const stats = await fs.stat(filePath);
            const fileAge = (now - stats.mtime) / (1000 * 60 * 60 * 24); // Convert to days
            
            if (fileAge > retentionDays) {
                await fs.unlink(filePath);
                console.log(`Deleted old log file: ${file}`);
            }
        }
    } catch (error) {
        console.error('Error cleaning up old logs:', error);
    }
}

// Run cleanup on startup and every 24 hours
cleanupOldLogs();
setInterval(cleanupOldLogs, 24 * 60 * 60 * 1000);

function parseBackupContent(content) {
    const lines = content.trim().split('\n');
    let currentVm = null;
    let vms = [];
    let totalInfo = {};
    let currentSection = '';

    for (const line of lines) {
        if (line.startsWith('Details')) {
            currentSection = 'details';
            continue;
        } else if (line.startsWith('Total')) {
            currentSection = 'total';
        } else if (line.startsWith('Logs')) {
            currentSection = 'logs';
            continue;
        }

        if (currentSection === 'details' && line.includes('VMID')) {
            continue;
        }

        if (currentSection === 'details' && line.trim() && !line.startsWith('=')) {
            const [vmid, name, status, time, size, filename] = line.split(/\s{2,}/);
            if (vmid && name) {
                currentVm = { vmid, name, status, time, size, filename, logs: [] };
                vms.push(currentVm);
            }
        }

        if (currentSection === 'total' && line.trim()) {
            if (line.includes('running time')) {
                totalInfo.runningTime = line.split(': ')[1];
            } else if (line.includes('Total size')) {
                totalInfo.totalSize = line.split(': ')[1];
            }
        }

        if (currentSection === 'logs' && line.trim() && !line.startsWith('=')) {
            if (line.includes('INFO:')) {
                const vmId = line.split(':')[0];
                const matchingVm = vms.find(vm => vm.vmid === vmId);
                if (matchingVm) {
                    matchingVm.logs.push(line.trim());
                }
            }
        }
    }

    return { vms, totalInfo };
}

function generateTextTable(jsonArray) {
    // Get headers, excluding 'logs' and 'filename'
    const headers = Object.keys(jsonArray[0])
        .filter(key => key !== 'logs' && key !== 'filename');

    // Calculate maximum width for each column including header
    const columnWidths = {};
    headers.forEach(header => {
    columnWidths[header] = header.length;
    jsonArray.forEach(row => {
        const cellContent = String(row[header] || '');
        columnWidths[header] = Math.max(columnWidths[header], cellContent.length);
    });
    });

    // Generate the header row
    const headerRow = headers.map(header => 
    header.padEnd(columnWidths[header])
    ).join(' | ');

    // Generate the separator line
    const separator = headers.map(header =>
    '-'.repeat(columnWidths[header])
    ).join('-|-');

    // Generate data rows
    const dataRows = jsonArray.map(row =>
    headers.map(header =>
        String(row[header] || '').padEnd(columnWidths[header])
    ).join(' | ')
    );

    // Combine all parts
    const table = `${headerRow}\n${separator}\n${dataRows.join('\n')}`;

    // Wrap in code block
    return `\`\`\`\n${table}\n\`\`\``;
};

function createEmbeds(webhookRequest, parsedContent, logFileName, urlLogAccessible) {
    const { vms, totalInfo } = parsedContent;
    let embeds = [];

    if (vms.length > 0) {
        const allOk = vms.every(vm => vm.status.toLowerCase() === 'ok');

        // Create backup embed
        const backupEmbed = {
            title: `Backup Summary (${vms.length} Jobs)`,
            fields: [
                {
                    name: 'Details',
                    value: generateTextTable(vms),
                    inline: false
                },
                {
                    name: '',
                    value: `**Total Time:** ${totalInfo.runningTime}\n**Total Size:** ${totalInfo.totalSize}\n\n`,
                    inline: false
                },
                {
                    name: '',
                    value: `Full logs available [here](${urlLogAccessible}${logFileName})`,
                    inline: false
                }
            ],
            color: allOk ? '2123412' : '15548997',
        };

        embeds.push(backupEmbed);
    } else {
        const genericEmbed = {
            title: webhookRequest.messageTitle,
            fields: [
                {
                    name: 'Message',
                    value: webhookRequest.messageContent,
                    inline: false
                },
                {
                    name: 'Severity',
                    value: webhookRequest.severity,
                    inline: false
                },
            ],
            color: '2123412',
        };

        embeds.push(genericEmbed);
    }
    
    return embeds;
}

app.post('/webhook', checkWebhookConfig, async (req, res) => {
    try {
        const webhookRequest = {
            discordWebhook: process.env.DISCORD_WEBHOOK_URL,
            messageContent: req.body.messageContent,
            urlLogAccessible: req.body.urlLogAccessible,
            severity: req.body.severity,
            messageTitle: req.body.messageTitle
        };

        const fileName = await exportLog(webhookRequest);
        console.log(`Log file ${fileName} written to disk`);

        const parsedContent = parseBackupContent(webhookRequest.messageContent);
        let embeds = createEmbeds(webhookRequest, parsedContent, fileName, webhookRequest.urlLogAccessible);

        const discordPayload = {
            content: '',
            embeds: embeds
        };

        // Attempt to send to Discord
        try {
            const response = await axios.post(webhookRequest.discordWebhook, discordPayload, {
                headers: { 'Content-Type': 'application/json' }
            });
            res.status(200).send(response.data);
        } catch (error) {
            if (error.response?.status === 400) {
                // If we get a 400 error, try sending a minimal fallback message
                const allOk = parsedContent.vms.every(vm => vm.status.toLowerCase() === 'ok');
                const fallbackEmbed = {
                    title: 'Backup Complete',
                    description: `Backup completed for ${parsedContent.vms.length} VMs. View full logs [here](${webhookRequest.urlLogAccessable}${fileName})`,
                    color: allOk ? '2123412' : '15548997'
                };

                const fallbackPayload = {
                    content: '',
                    embeds: [fallbackEmbed]
                };

                const fallbackResponse = await axios.post(webhookRequest.discordWebhook, fallbackPayload, {
                    headers: { 'Content-Type': 'application/json' }
                });
                res.status(200).send(fallbackResponse.data);
            } else {
                throw error;
            }
        }
    } catch (error) {
        console.error('Error processing webhook:', error);
        res.status(400).send(error.message);
    }
});

const PORT = process.env.PORT || 80;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Log retention period set to ${process.env.LOG_RETENTION_DAYS || '3'} days`);
});