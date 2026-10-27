/**
 * #15134: the bench-cowork Cole agent reads the live pipeline. Its frontmatter
 * `tools:` line names each Bench MCP read exactly (never a whole server), so a
 * Cole run gets the deal and stuck-job reads its skills call
 * (apps/agents/cole/TOOLS.md) and nothing that sends, publishes, schedules,
 * changes the team, deletes or touches money.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { MCP_TOOL_POLICIES } from '@/app/api/v1/mcp/tool-policies';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(__dirname, '..');

function frontmatterTools(file: string): string[] {
  const text = readFileSync(resolve(pluginRoot, file), 'utf8');
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!frontmatter) throw new Error(`${file} has no frontmatter`);
  const line = frontmatter[1].split('\n').find((row) => row.startsWith('tools:'));
  if (!line) throw new Error(`${file} has no tools: line`);
  const list = /^tools:\s*\[(.*)\]\s*$/.exec(line);
  if (!list) throw new Error(`${file} tools: line is not a [..] list`);
  return list[1].split(',').map((name) => name.trim()).filter(Boolean);
}

const COLE_BENCH_OPS_READS = [
  'list_deals',
  'get_deal',
  'get_deal_activity',
  'get_deal_notes',
  'pipeline_summary',
  'pipeline_stuck_jobs',
  'pipeline_joins',
  'list_appointments',
  'list_contacts',
];

// The Bench tools Claude seats deny outright: sends, posts, publishes,
// calendar writes, team changes, deal deletion and the money connection.
const BENCH_OUTBOUND_TOOLS = [
  'email_send',
  'order_direct_mail',
  'cancel_direct_mail_order',
  'publish_instagram_image',
  'proposal_publish',
  'notify_team_member',
  'create_calendar_event',
  'create_google_calendar_event',
  'update_google_calendar_event',
  'delete_google_calendar_event',
  'team_invite_member',
  'team_remove_member',
  'team_revoke_invite',
  'team_set_role',
  'team_set_member_teams',
  'delete_deal',
  'connect_quickbooks',
];

const BENCH_SERVERS = ['bench-ops', 'bench-deals'];

describe('the bench-cowork Cole agent tool line (#15134)', () => {
  const tools = frontmatterTools('agents/cole.md');

  it('names every pipeline read his skills call, as exact bench-ops tools', () => {
    for (const name of COLE_BENCH_OPS_READS) {
      expect(tools, name).toContain(`mcp__bench-ops__${name}`);
    }
  });

  it('grants no whole Bench server, which would hand him every write and send', () => {
    for (const server of BENCH_SERVERS) {
      expect(tools).not.toContain(`mcp__${server}`);
    }
  });

  it('holds none of the outbound, money or team tools', () => {
    for (const name of BENCH_OUTBOUND_TOOLS) {
      expect(MCP_TOOL_POLICIES[name], `${name} is a real Bench tool`).toBeDefined();
      for (const server of BENCH_SERVERS) {
        expect(tools, name).not.toContain(`mcp__${server}__${name}`);
      }
    }
  });

  it('holds only read-tier bench-ops tools that Bench serves', () => {
    const benchOps = tools.filter((name) => name.startsWith('mcp__bench-ops__'));
    expect(benchOps.length).toBeGreaterThanOrEqual(COLE_BENCH_OPS_READS.length);
    for (const entry of benchOps) {
      const name = entry.slice('mcp__bench-ops__'.length);
      const policy = MCP_TOOL_POLICIES[name];
      expect(policy, `${name} is a real Bench tool`).toBeDefined();
      expect(policy.tier, `${name} is a read`).toBe('read');
    }
  });

  it('holds only the GET tools of the bench-deals manifest', () => {
    const manifest = JSON.parse(readFileSync(resolve(pluginRoot, 'mcp/bench-deals.json'), 'utf8')) as {
      tools: Array<{ name: string; method: string }>;
    };
    const methods = new Map(manifest.tools.map((tool) => [tool.name, tool.method]));
    const benchDeals = tools.filter((name) => name.startsWith('mcp__bench-deals__'));
    expect(benchDeals.length).toBeGreaterThan(0);
    for (const entry of benchDeals) {
      const name = entry.slice('mcp__bench-deals__'.length);
      expect(methods.get(name), `${name} is a GET in bench-deals.json`).toBe('GET');
    }
    expect(tools).not.toContain('mcp__bench-deals__deal_create');
  });

  it('keeps every other entry to the local, wiki and canvas tools it had', () => {
    const rest = tools.filter((name) => !BENCH_SERVERS.some((server) => name.startsWith(`mcp__${server}__`)));
    expect(rest).toEqual(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'WebFetch', 'mcp__bench-wiki', 'mcp__bench-canvas']);
  });
});
