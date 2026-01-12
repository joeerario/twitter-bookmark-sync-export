#!/usr/bin/env node
/**
 * Account Setup CLI
 *
 * Manages Twitter/X account credentials.
 *
 * Security: Credentials are collected via interactive prompts or environment
 * variables to avoid leaking secrets via shell history or process list.
 */

import './env.js';

import readline from 'readline';
import {
  addAccount,
  listAccounts,
  loadAccounts,
  removeAccount,
  revalidateAccounts,
  setAccountEnabled,
} from './accounts.js';

const command = process.argv[2];
const args = process.argv.slice(3);

/**
 * Read a line from stdin (optionally with masked input for passwords)
 */
function prompt(question: string, masked = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    if (masked && process.stdin.isTTY) {
      // For masked input, we need to handle it manually
      process.stdout.write(question);

      const stdin = process.stdin;
      const originalRawMode = stdin.isRaw;

      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding('utf8');

      let input = '';

      const onData = (char: string) => {
        // Handle Ctrl+C
        if (char === '\u0003') {
          process.stdout.write('\n');
          process.exit(1);
        }

        // Handle Enter
        if (char === '\r' || char === '\n') {
          stdin.setRawMode(originalRawMode ?? false);
          stdin.removeListener('data', onData);
          stdin.pause();
          process.stdout.write('\n');
          rl.close();
          resolve(input);
          return;
        }

        // Handle Backspace
        if (char === '\u007f' || char === '\b') {
          if (input.length > 0) {
            input = input.slice(0, -1);
            process.stdout.write('\b \b');
          }
          return;
        }

        // Regular character
        input += char;
        process.stdout.write('*');
      };

      stdin.on('data', onData);
    } else {
      // Non-TTY or non-masked: use regular readline
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

/**
 * Get credentials from environment variables or interactive prompt
 */
async function getCredentials(): Promise<{ authToken: string; ct0: string }> {
  // Check environment variables first
  const envAuthToken = process.env.TWITTER_AUTH_TOKEN;
  const envCt0 = process.env.TWITTER_CT0;

  if (envAuthToken && envCt0) {
    console.log('Using credentials from environment variables.');
    return { authToken: envAuthToken, ct0: envCt0 };
  }

  // Check if stdin is a TTY (interactive terminal)
  if (!process.stdin.isTTY) {
    console.error('Error: No credentials provided.');
    console.error('Next steps:');
    console.error('  1) Run interactively: npm run setup -- add');
    console.error('  2) Or use env vars:');
    console.error('     TWITTER_AUTH_TOKEN=xxx TWITTER_CT0=xxx npm run setup -- add');
    process.exit(1);
  }

  console.log('\nGet these values from Chrome DevTools:');
  console.log('  1. Go to x.com');
  console.log('  2. Open DevTools (Cmd+Option+I)');
  console.log('  3. Application tab → Cookies → x.com');
  console.log('  4. Copy auth_token and ct0 values\n');

  const authToken = await prompt('auth_token: ', true);
  if (!authToken.trim()) {
    console.error('Error: auth_token cannot be empty');
    process.exit(1);
  }

  const ct0 = await prompt('ct0: ', true);
  if (!ct0.trim()) {
    console.error('Error: ct0 cannot be empty');
    process.exit(1);
  }

  return { authToken: authToken.trim(), ct0: ct0.trim() };
}

async function main(): Promise<void> {
  switch (command) {
    case 'add': {
      // Check for legacy CLI arg usage and warn
      if (args.length >= 2) {
        console.error('Warning: Passing credentials as CLI arguments is insecure.');
        console.error('Credentials may be visible in shell history and process list.\n');
        console.error('Use one of these secure methods instead:');
        console.error('  1. Run interactively: node dist/setup.js add');
        console.error('  2. Use environment variables:');
        console.error('     TWITTER_AUTH_TOKEN=xxx TWITTER_CT0=xxx node dist/setup.js add\n');
        process.exit(1);
      }

      const { authToken, ct0 } = await getCredentials();
      console.log('\nAdding account...');

      const result = await addAccount(authToken, ct0);

      if (result.success) {
        if (result.updated) {
          console.log(`Updated existing account: @${result.account!.username}`);
        } else {
          console.log(`Added new account: @${result.account!.username} (${result.account!.name})`);
        }
      } else {
        console.error(`Failed to add account: ${result.error}`);
        console.error('Next steps: confirm `auth_token` and `ct0` from DevTools, then rerun `npm run setup -- add`.');
        process.exit(1);
      }
      break;
    }

    case 'list': {
      const accounts = await listAccounts();

      if (accounts.length === 0) {
        console.log('No accounts configured.');
        console.log('\nAdd an account:');
        console.log('  node dist/setup.js add');
        break;
      }

      console.log('Configured accounts:\n');
      for (const acc of accounts) {
        const status = acc.enabled ? '✓' : '✗';
        const error = acc.hasError ? ' (has error)' : '';
        console.log(`${status} @${acc.username} - ${acc.name}${error}`);
        console.log(`    Added: ${acc.addedAt}`);
        console.log(`    Last validated: ${acc.lastValidated || 'never'}`);
      }
      break;
    }

    case 'remove': {
      if (args.length < 1) {
        console.log('Usage: node dist/setup.js remove <username>');
        process.exit(1);
      }

      const username = args[0]!.replace('@', '');
      const result = await removeAccount(username);

      if (result.success) {
        console.log(`Removed account: @${result.account!.username}`);
      } else {
        console.error(result.error);
        process.exit(1);
      }
      break;
    }

    case 'enable': {
      if (args.length < 1) {
        console.log('Usage: node dist/setup.js enable <username>');
        process.exit(1);
      }

      const username = args[0]!.replace('@', '');
      const result = await setAccountEnabled(username, true);

      if (result.success) {
        console.log(`Enabled account: @${result.account!.username}`);
      } else {
        console.error(result.error);
        process.exit(1);
      }
      break;
    }

    case 'disable': {
      if (args.length < 1) {
        console.log('Usage: node dist/setup.js disable <username>');
        process.exit(1);
      }

      const username = args[0]!.replace('@', '');
      const result = await setAccountEnabled(username, false);

      if (result.success) {
        console.log(`Disabled account: @${result.account!.username}`);
      } else {
        console.error(result.error);
        process.exit(1);
      }
      break;
    }

    case 'validate': {
      console.log('Revalidating all accounts...\n');
      const results = await revalidateAccounts();

      for (const r of results) {
        if (r.valid) {
          console.log(`@${r.account}: valid`);
        } else {
          console.log(`@${r.account}: ${r.error}`);
        }
      }

      if (results.length === 0) {
        console.log('No accounts to validate.');
      }
      break;
    }

    case 'status': {
      const accounts = await loadAccounts();

      if (accounts.length === 0) {
        console.log('No accounts configured.');
        break;
      }

      console.log('Account Status:\n');

      for (const acc of accounts) {
        const status = acc.enabled ? 'ENABLED' : 'DISABLED';
        console.log(`@${acc.username} (${acc.name})`);
        console.log(`  Status: ${status}`);
        console.log(`  User ID: ${acc.userId || 'unknown'}`);
        console.log(`  Added: ${acc.addedAt}`);
        console.log(`  Last validated: ${acc.lastValidated}`);
        if (acc.validationError) {
          console.log(`  Error: ${acc.validationError}`);
        }
        console.log('');
      }
      break;
    }

    default:
      console.log(`
Bookmark Automation - Account Setup

Commands:
  add                      Add a new Twitter account (prompts for credentials)
  list                     List all configured accounts
  remove <username>        Remove an account
  enable <username>        Enable an account for polling
  disable <username>       Disable an account (keep config)
  validate                 Revalidate all account credentials
  status                   Show detailed account status

Secure credential input:
  Interactive:    node dist/setup.js add
  Environment:    TWITTER_AUTH_TOKEN=xxx TWITTER_CT0=xxx node dist/setup.js add

Examples:
  node dist/setup.js add
  node dist/setup.js list
  node dist/setup.js disable joept_
  node dist/setup.js enable mtnbeer00
  node dist/setup.js validate
      `);
  }
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
