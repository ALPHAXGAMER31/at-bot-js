import { SlashCommandBuilder } from 'discord.js';

export async function setup(client) {

    const commands = [
        {
            data: new SlashCommandBuilder()
                .setName('ping')
                .setDescription('🏓 اختبار سرعة البوت'),

            execute: async (interaction, client) => {
                await interaction.reply({
                    content: `🏓 Pong! \`${Math.round(client.ws.ping)}ms\``,
                    ephemeral: true,
                });
            }
        }
    ];

    // ✅ تسجيل في client للتنفيذ
    for (const cmd of commands) {
        client.slashCommands.set(cmd.data.name, cmd);
    }

    // ✅ رجّع JSON للمزامنة بس
    return {
        slashCommands: commands.map(c => c.data.toJSON())
    };
}
