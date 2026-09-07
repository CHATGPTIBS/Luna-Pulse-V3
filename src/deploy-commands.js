import { REST, Routes } from 'discord.js';
import { config } from './config.js';
import { commands } from './commands.js';

function normalizeOptions(options = []) {
  const rows = options.map(option => ({
    ...option,
    ...(Array.isArray(option.options) ? { options: normalizeOptions(option.options) } : {}),
  }));

  // Subcommands/subcommand groups must retain their declared order. Their own
  // child options are normalized recursively above. For ordinary option lists,
  // Discord requires every required option to appear before optional options.
  const containsSubcommands = rows.some(option => option.type === 1 || option.type === 2);
  if (containsSubcommands) return rows;

  return rows.sort((a, b) => Number(Boolean(b.required)) - Number(Boolean(a.required)));
}

const normalizedCommands = commands.map(command => ({
  ...command,
  options: normalizeOptions(command.options || []),
}));

const rest = new REST({ version: '10' }).setToken(config.discordToken);
const route = config.guildId
  ? Routes.applicationGuildCommands(config.clientId, config.guildId)
  : Routes.applicationCommands(config.clientId);

await rest.put(route, { body: normalizedCommands });
console.log(`Registered ${normalizedCommands.length} commands ${config.guildId ? 'to guild ' + config.guildId : 'globally'}.`);
