import { REST, Routes } from 'discord.js';
import { config } from './config.js';
import { commands } from './commands.js';

const rest = new REST({ version: '10' }).setToken(config.discordToken);
const route = config.guildId
  ? Routes.applicationGuildCommands(config.clientId, config.guildId)
  : Routes.applicationCommands(config.clientId);
await rest.put(route, { body: commands });
console.log(`Registered ${commands.length} commands ${config.guildId ? 'to guild ' + config.guildId : 'globally'}.`);
