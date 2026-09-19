import { ChannelType } from 'discord.js';

export async function setup(client) {
    const HEARTBEAT_CHANNEL_ID = process.env.HEARTBEAT_CHANNEL_ID;

    if (!HEARTBEAT_CHANNEL_ID || HEARTBEAT_CHANNEL_ID === 'YOUR_CHANNEL_ID_HERE') {
        console.log('  ⏭️  [Module] Keep-Alive → skipped (no channel ID)');
        return;
    }

    console.log('  🚀 [Module] Keep-Alive System Loaded.');

    const sendHeartbeat = async () => {
        try {
            const channel = await client.channels.fetch(HEARTBEAT_CHANNEL_ID).catch(() => null);
            if (channel && channel.type === ChannelType.GuildText) {
                await channel.send(`📡 **AT BOT Heartbeat:** System is active. [${new Date().toLocaleString()}]`);
                console.log('  ✅ Heartbeat sent successfully.');
            }
        } catch (error) {
            console.error('  ❌ Failed to send heartbeat:', error.message);
        }
    };

    const INTERVAL = 24 * 60 * 60 * 1000;
    setInterval(sendHeartbeat, INTERVAL);
}
