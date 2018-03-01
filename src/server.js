// Check for environmental variables.
require('checkenv').check();

const discord = require('discord.js');
const path = require('path');
const schedule = require('node-schedule');
const fs = require('fs');

const logger = require('./logging.js');
const state = require('./state.js');

// Load custom responses
if (process.env.DATA_CUSTOM_RESPONSES) {
  fs.readFile('/data/responses.json', 'utf8', function (err, data) {
    if (err) { throw err; }
    state.responses = JSON.parse(data);
    logger.debug('Loaded responses file from external source.');
  });
} else {
  state.responses = require('./responses.json');
  logger.warn(`Loaded resources file from the default, no external source found.`);
}

var cachedModules = [];
var cachedTriggers = [];
var client = new discord.Client();

process.on('unhandledRejection', (error, promise) => {
	logger.error(`Unhandled promise rejection: ${error.message}.`, error);
});

process.on('uncaughtException', error => {
	logger.error(`Unhandled exception: ${error.message}.`, error);
});

function findArray(haystack, arr) {
  return arr.some(function (v) {
    return haystack.indexOf(v) >= 0;
  });
}

client.on('ready', () => {
  // Initalize app channels.
  state.logChannel = client.channels.get(process.env.DISCORD_LOG_CHANNEL);
  state.guild = state.logChannel.guild;

  logger.info('Bot is now online and connected to server.');
});

client.on('guildMemberAdd', (member) => {
  member.addRole(process.env.DISCORD_RULES_ROLE);
  state.stats.joins += 1;
});

client.on('guildMemberRemove', (member) => {
  state.stats.leaves += 1;
});

// Output the stats for state.stats every 24 hours.
// Server is in UTC mode, 11:30 EST would be 03:30 UTC.
schedule.scheduleJob({ hour: 3, minute: 30 }, function () {
  logger.info(`Here are today's stats for ${(new Date()).toLocaleDateString()}! ${state.stats.joins} users have joined, ${state.stats.ruleAccepts} users have accepted the rules, ${state.stats.leaves} users have left.`, {
    meta: { stats: state.stats }
  });
  state.logChannel.send(`Here are today's stats for ${(new Date()).toLocaleDateString()}! ${state.stats.joins} users have joined, ${state.stats.ruleAccepts} users have accepted the rules, ${state.stats.leaves} users have left.`);

  // Clear the stats for the day.
  state.stats.joins = 0;
  state.stats.ruleAccepts = 0;
  state.stats.leaves = 0;
});

client.on('message', message => {
  if (message.author.bot && message.content.startsWith('.ban') === false) { return; }

  if (message.guild == null && state.responses.pmReply) {
    // We want to log PM attempts.
    logger.info(`${message.author.username} ${message.author} [PM]: ${message.content}`);
    state.logChannel.send(`${message.author} [PM]: ${message.content}`);
    message.reply(state.responses.pmReply);
    return;
  }

  logger.verbose(`${message.author.username} ${message.author} [Channel: ${message.channel.name} ${message.channel}]: ${message.content}`);

  // Check if the channel is #rules, if so we want to follow a different logic flow.
  if (message.channel.id === process.env.DISCORD_RULES_CHANNEL) {
    if (message.content.includes(process.env.DISCORD_RULES_TRIGGER)) {
      // We want to remove the 'Unauthorized' role from them once they agree to the rules.
      logger.verbose(`${message.author.username} ${message.author} has accepted the rules, removing role ${process.env.DISCORD_RULES_ROLE}.`);
      state.stats.ruleAccepts += 1;

      message.member.removeRole(process.env.DISCORD_RULES_ROLE, 'Accepted the rules.');
    }

    // Delete the message in the channel to force a cleanup.
    message.delete();
    return;
  } else if (message.content.startsWith('.') && message.content.startsWith('..') === false) {
    // We want to make sure it's an actual command, not someone '...'-ing.
    let cmd = message.content.split(' ')[0].slice(1);

    // Check by the name of the command.
    let cachedModule = cachedModules[`${cmd}.js`];
    let cachedModuleType = 'Command';
    // Check by the quotes in the configuration.
    if (cachedModule == null) { cachedModule = state.responses.quotes[cmd]; cachedModuleType = 'Quote'; }

    if (cachedModule) {
      // Check access permissions.
      if (cachedModule.roles !== undefined && findArray(message.member.roles.map(function (x) { return x.name; }), cachedModule.roles) === false) {
        state.logChannel.send(`${message.author} attempted to use admin command: ${message.content}`);
        logger.info(`${message.author.username} ${message.author} attempted to use admin command: ${message.content}`);
        return false;
      }

      logger.info(`${message.author.username} ${message.author} [Channel: ${message.channel}] executed command: ${message.content}`);
      message.delete();

      try {
        if (cachedModuleType === 'Command') {
          cachedModule.command(message);
        } else if (cachedModuleType === 'Quote') {
          cachedModules['quote.js'].command(message, cachedModule.reply);
        }
      } catch (err) { logger.error(err); }
    }
  } else if (message.author.bot === false) {
    // This is a normal channel message.
    cachedTriggers.forEach(function (trigger) {
      if (trigger.roles === undefined || findArray(message.member.roles.map(function (x) { return x.name; }), trigger.roles)) {
        if (trigger.trigger(message) === true) {
          logger.debug(`${message.author.username} ${message.author} [Channel: ${message.channel}] triggered: ${message.content}`);
          try {
            trigger.execute(message);
          } catch (err) { logger.error(err); }
        }
      }
    });
  }
});

// Cache all command modules.
cachedModules = [];
fs.readdirSync('./src/commands/').forEach(function (file) {
  // Load the module if it's a script.
  if (path.extname(file) === '.js') {
    if (file.includes('.disabled')) {
      logger.info(`Did not load disabled module: ${file}`);
    } else {
      logger.info(`Loaded module: ${file}`);
      cachedModules[file] = require(`./commands/${file}`);
    }
  }
});

// Cache all triggers.
cachedTriggers = [];
fs.readdirSync('./src/triggers/').forEach(function (file) {
  // Load the trigger if it's a script.
  if (path.extname(file) === '.js') {
    if (file.includes('.disabled')) {
      logger.info(`Did not load disabled trigger: ${file}`);
    } else {
      logger.info(`Loaded trigger: ${file}`);
      cachedTriggers.push(require(`./triggers/${file}`));
    }
  }
});

client.login(process.env.DISCORD_LOGIN_TOKEN);
logger.info('Startup completed. Established connection to Discord.');
