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
            const [vmid, name, status, time, size, filename] = line.split(/\s+/);
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

const DISCORD_LIMITS = {
    MESSAGE_CONTENT: 2000,
    EMBED_TITLE: 256,
    EMBED_DESCRIPTION: 4096,
    EMBED_FIELDS: 25,
    EMBED_FIELD_NAME: 256,
    EMBED_FIELD_VALUE: 1024,
    EMBED_FOOTER_TEXT: 2048,
    EMBED_AUTHOR_NAME: 256,
    TOTAL_EMBEDS: 10,
    // Discord has a total character limit of 6000 across all embed fields in a message
    TOTAL_CHARACTERS: 6000
};

function truncateString(str, maxLength) {
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength - 3) + '...';
}

function calculateEmbedLength(embed) {
    let length = 0;
    
    // Add title length
    if (embed.title) length += embed.title.length;
    
    // Add description length
    if (embed.description) length += embed.description.length;
    
    // Add fields length
    if (embed.fields) {
        for (const field of embed.fields) {
            length += field.name.length + field.value.length;
        }
    }
    
    // Add footer length
    if (embed.footer?.text) length += embed.footer.text.length;
    
    return length;
}

function createBackupEmbeds(parsedContent, logFileName, urlLogAccessible) {
    const { vms, totalInfo } = parsedContent;
    let embeds = [];
    let totalLength = 0;

    // Create summary embed
    const summaryEmbed = {
        title: truncateString(`Backup Summary (${vms.length} VMs)`, DISCORD_LIMITS.EMBED_TITLE),
        description: truncateString(
            `**Total Time:** ${totalInfo.runningTime}\n` +
            `**Total Size:** ${totalInfo.totalSize}\n\n` +
            `Full logs available [here](${urlLogAccessible}${logFileName})`,
            DISCORD_LIMITS.EMBED_DESCRIPTION
        ),
        color: '2123412'
    };

    totalLength += calculateEmbedLength(summaryEmbed);
    embeds.push(summaryEmbed);

    // Create VM embeds
    for (const vm of vms) {
        if (embeds.length >= DISCORD_LIMITS.TOTAL_EMBEDS) {
            console.log('Reached maximum embed limit, consolidating remaining VMs...');
            break;
        }

        const vmEmbed = {
            title: truncateString(`${vm.name} (VM ${vm.vmid})`, DISCORD_LIMITS.EMBED_TITLE),
            fields: [
                {
                    name: '📊 Details',
                    value: truncateString(
                        `**Status:** ${vm.status}\n` +
                        `**Time:** ${vm.time}\n` +
                        `**Size:** ${vm.size}`,
                        DISCORD_LIMITS.EMBED_FIELD_VALUE
                    ),
                    inline: false
                }
            ],
            color: vm.status === 'ok' ? '2123412' : '15548997',
            footer: {
                text: truncateString(path.basename(vm.filename), DISCORD_LIMITS.EMBED_FOOTER_TEXT)
            }
        };

        const embedLength = calculateEmbedLength(vmEmbed);
        if (totalLength + embedLength <= DISCORD_LIMITS.TOTAL_CHARACTERS) {
            totalLength += embedLength;
            embeds.push(vmEmbed);
        } else {
            // If we can't fit more detailed embeds, create a consolidated embed for remaining VMs
            const remainingVms = vms.slice(vms.indexOf(vm));
            const consolidatedEmbed = createConsolidatedEmbed(remainingVms);
            if (totalLength + calculateEmbedLength(consolidatedEmbed) <= DISCORD_LIMITS.TOTAL_CHARACTERS) {
                embeds.push(consolidatedEmbed);
            }
            break;
        }
    }

    return embeds;
}

function createConsolidatedEmbed(vms) {
    const vmSummaries = vms.map(vm => 
        `**${vm.name} (${vm.vmid})**: ${vm.status} - ${vm.size}`
    );

    return {
        title: truncateString(`Additional VMs (${vms.length})`, DISCORD_LIMITS.EMBED_TITLE),
        description: truncateString(vmSummaries.join('\n'), DISCORD_LIMITS.EMBED_DESCRIPTION),
        color: '2123412'
    };
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

        console.log(JSON.stringify(webhookRequest));

        const fileName = await exportLog(webhookRequest);
        console.log(`Log file ${fileName} written to disk`);

        const parsedContent = parseBackupContent(webhookRequest.messageContent);
        let embeds = createBackupEmbeds(parsedContent, fileName, webhookRequest.urlLogAccessible);

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
                const fallbackEmbed = {
                    title: 'Backup Complete',
                    description: truncateString(
                        `Backup completed for ${parsedContent.vms.length} VMs. View full logs [here](${webhookRequest.urlLogAccessable}${fileName})`,
                        DISCORD_LIMITS.EMBED_DESCRIPTION
                    ),
                    color: '2123412'
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
});