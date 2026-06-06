#!/usr/bin/env node
/**
 * GitHub Stats Card Generator
 * ─────────────────────────────────────────────────────────────
 * No external dependencies — uses Node 18+ native fetch.
 * Generates: github-stats.svg, github-top-langs.svg
 *
 * Setup:
 *   1. Go to https://github.com/settings/tokens/new
 *   2. Select scopes:  read:user  +  repo  (repo needed for private contributions)
 *   3. Copy the token and add it as a repo secret named GH_TOKEN
 *   4. The GitHub Action will run this script automatically
 */

'use strict';
const fs = require('fs');

const USERNAME = process.env.GITHUB_USERNAME;
const TOKEN    = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

if (!USERNAME || !TOKEN) {
  console.error('  Set GITHUB_USERNAME and GH_TOKEN environment variables.');
  process.exit(1);
}

// ─── GitHub GraphQL client ────────────────────────────────────────────────────

async function gql(query, variables = {}) {
  const res = await fetch('https://api.github.com/graphql', {
    method : 'POST',
    headers: {
      Authorization : `bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent'  : 'github-stats-generator/1.0',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${res.status}: ${text}`);
  }

  const { data, errors } = await res.json();
  if (errors?.length) throw new Error(errors.map(e => e.message).join('; '));
  return data;
}

// ─── Data fetchers ────────────────────────────────────────────────────────────

async function fetchUser() {
  const { user } = await gql(`
    query($login: String!) {
      user(login: $login) {
        name login createdAt
        followers { totalCount }
      }
    }
  `, { login: USERNAME });
  return user;
}

/**
 * GitHub's contributionsCollection only supports a max 1-year window per query.
 * We iterate year-by-year from account creation to today to get the true total.
 */
async function fetchAllContributions(createdAt) {
  const startYear = new Date(createdAt).getFullYear();
  const nowYear   = new Date().getFullYear();
  const totals    = { all: 0, commits: 0, prs: 0, issues: 0, reviews: 0 };

  for (let year = startYear; year <= nowYear; year++) {
    const from = `${year}-01-01T00:00:00Z`;
    const to   = year === nowYear
      ? new Date().toISOString().slice(0, 19) + 'Z'
      : `${year}-12-31T23:59:59Z`;

    try {
      const { user } = await gql(`
        query($login: String!, $from: DateTime!, $to: DateTime!) {
          user(login: $login) {
            contributionsCollection(from: $from, to: $to) {
              totalCommitContributions
              totalPullRequestContributions
              totalIssueContributions
              totalPullRequestReviewContributions
              contributionCalendar { totalContributions }
            }
          }
        }
      `, { login: USERNAME, from, to });

      const c = user.contributionsCollection;
      totals.all     += c.contributionCalendar.totalContributions;
      totals.commits += c.totalCommitContributions;
      totals.prs     += c.totalPullRequestContributions;
      totals.issues  += c.totalIssueContributions;
      totals.reviews += c.totalPullRequestReviewContributions;

      console.log(`  ${year}: ${c.contributionCalendar.totalContributions} contributions`);
    } catch (err) {
      console.warn(`  ${year}: skipped — ${err.message}`);
    }
  }

  return totals;
}

async function fetchRepoStats() {
  let totalStars = 0;
  const langs    = {};
  let cursor     = null;
  let hasMore    = true;

  while (hasMore) {
    const { user } = await gql(`
      query($login: String!, $cursor: String) {
        user(login: $login) {
          repositories(
            first: 100
            after: $cursor
            ownerAffiliations: OWNER
          ) {
            pageInfo { hasNextPage endCursor }
            nodes {
              isFork
              stargazerCount
              languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
                edges { size node { name color } }
              }
            }
          }
        }
      }
    `, { login: USERNAME, cursor });

    const { nodes, pageInfo } = user.repositories;
    hasMore = pageInfo.hasNextPage;
    cursor  = pageInfo.endCursor;

    for (const repo of nodes) {
      if (repo.isFork) continue;
      totalStars += repo.stargazerCount;
      for (const { size, node } of repo.languages.edges) {
        langs[node.name] ??= { size: 0, color: node.color ?? '#888' };
        langs[node.name].size += size;
      }
    }
  }

  const totalSize = Object.values(langs).reduce((s, l) => s + l.size, 0) || 1;
  const top = Object.entries(langs)
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 8)
    .map(([name, { size, color }]) => ({
      name,
      color,
      pct: +((size / totalSize) * 100).toFixed(1),
    }));

  return { totalStars, top };
}

// ─── SVG helpers ──────────────────────────────────────────────────────────────

const THEME = {
  bg    : '#141321',
  sep   : '#2d2b55',
  title : '#fe428e',
  label : '#a9fef7',
  value : '#fe428e',
  muted : '#8b949e',
  text  : '#cdd9e5',
  g1    : '#fe428e',
  g2    : '#a56cc1',
};

const FONT = "'Segoe UI', Helvetica, Arial, sans-serif";

const abbr = n =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
  : n >= 1_000   ? `${(n / 1_000).toFixed(1)}k`
  : String(n);

const esc = s =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const today = new Date().toLocaleDateString('en-US', {
  month: 'short', day: 'numeric', year: 'numeric',
});

/** Shared card shell: dark bg + gradient top strip + rounded clip */
function card(w, h, extraDefs, body) {
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
<defs>
  <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="0%">
    <stop offset="0%"   stop-color="${THEME.g1}"/>
    <stop offset="100%" stop-color="${THEME.g2}"/>
  </linearGradient>
  <clipPath id="card-clip">
    <rect width="${w}" height="${h}" rx="10"/>
  </clipPath>
  ${extraDefs}
</defs>
<g clip-path="url(#card-clip)">
  <rect width="${w}" height="${h}" fill="${THEME.bg}"/>
  <rect width="${w}" height="4"   fill="url(#grad)"/>
  ${body}
</g>
</svg>`;
}

/** One stat row: coloured dot · label text · right-aligned value */
function statItem(dotX, y, label, value) {
  // Values right-align at the end of each column's half
  const valX  = dotX < 248 ? 244 : 474;
  const textY = y + 5;
  return `
  <circle cx="${dotX}" cy="${y}" r="5" fill="${THEME.title}"/>
  <text x="${dotX + 14}" y="${textY}" font-family="${FONT}" font-size="13" fill="${THEME.label}">${esc(label)}:</text>
  <text x="${valX}"      y="${textY}" font-family="${FONT}" font-size="13" font-weight="700" fill="${THEME.value}" text-anchor="end">${esc(value)}</text>`;
}

// ─── Card generators ──────────────────────────────────────────────────────────

function makeStatsCard(user, contrib, repoStats) {
  const displayName = esc(user.name || user.login);

  const body = `
  <!-- Title -->
  <text x="25" y="37" font-family="${FONT}" font-size="16" font-weight="700" fill="${THEME.title}">${displayName}'s GitHub Stats</text>
  <text x="25" y="55" font-family="${FONT}" font-size="11"                   fill="${THEME.muted}">All-time ✦ Updated ${today}</text>
  <line x1="25" y1="67" x2="470" y2="67" stroke="${THEME.sep}" stroke-width="1"/>

  <!-- Left column -->
  ${statItem(25,  96,  'Total Contributions', abbr(contrib.all))}
  ${statItem(25,  127, 'Total Commits',       abbr(contrib.commits))}
  ${statItem(25,  158, 'Stars Earned',        abbr(repoStats.totalStars))}

  <!-- Right column -->
  ${statItem(255, 96,  'Total PRs',   abbr(contrib.prs))}
  ${statItem(255, 127, 'Total Issues',abbr(contrib.issues))}
  ${statItem(255, 158, 'Followers',   abbr(user.followers.totalCount))}`;

  return card(495, 185, '', body);
}

function makeLangsCard(top) {
  if (!top.length) {
    return card(300, 100, '', `<text x="25" y="60" font-family="${FONT}" font-size="13" fill="${THEME.muted}">No public languages found.</text>`);
  }

  const BAR_X = 25, BAR_W = 270, BAR_Y = 60, BAR_H = 8;
  const rows  = Math.ceil(top.length / 2);
  const svgH  = BAR_Y + BAR_H + 24 + rows * 28 + 12;

  // Build bar segments
  let x = BAR_X;
  const segments = top.map(lang => {
    const w = (lang.pct / 100) * BAR_W;
    const seg = `<rect x="${x.toFixed(2)}" y="${BAR_Y}" width="${w.toFixed(2)}" height="${BAR_H}" fill="${lang.color}"/>`;
    x += w;
    return seg;
  }).join('\n    ');

  // Build legend (2 columns)
  const legend = top.map((lang, i) => {
    const col  = i % 2 === 0 ? 25 : 175;
    const rowY = BAR_Y + BAR_H + 22 + Math.floor(i / 2) * 28;
    return `
  <circle cx="${col + 6}" cy="${rowY}"     r="6"  fill="${lang.color}"/>
  <text   x="${col + 20}" y="${rowY + 5}"  font-family="${FONT}" font-size="12" fill="${THEME.text}">${esc(lang.name)}</text>
  <text   x="${col + 145}" y="${rowY + 5}" font-family="${FONT}" font-size="12" fill="${THEME.muted}" text-anchor="end">${lang.pct}%</text>`;
  }).join('');

  const extraDefs = `<clipPath id="bar-clip">
    <rect x="${BAR_X}" y="${BAR_Y}" width="${BAR_W}" height="${BAR_H}" rx="4"/>
  </clipPath>`;

  const body = `
  <!-- Title -->
  <text x="25" y="37" font-family="${FONT}" font-size="16" font-weight="700" fill="${THEME.title}">Most Used Languages</text>

  <!-- Progress bar -->
  <rect x="${BAR_X}" y="${BAR_Y}" width="${BAR_W}" height="${BAR_H}" rx="4" fill="${THEME.sep}"/>
  <g clip-path="url(#bar-clip)">
    ${segments}
  </g>

  <!-- Legend -->
  ${legend}`;

  return card(320, svgH, extraDefs, body);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n  Generating GitHub stats for @${USERNAME}\n`);

  console.log('Fetching user info...');
  const user     = await fetchUser();
  const joinYear = new Date(user.createdAt).getFullYear();
  console.log(`${user.name || user.login}  (joined ${joinYear})\n`);

  console.log('  Fetching all-time contributions (year by year):');
  const contrib = await fetchAllContributions(user.createdAt);
  console.log(`\n  ${contrib.all.toLocaleString()} total contributions\n`);

  console.log('  Fetching repo stats & language bytes...');
  const repoStats = await fetchRepoStats();
  console.log(`    ${repoStats.totalStars} stars  |  ${repoStats.top.map(l => l.name).join(', ')}\n`);

  fs.writeFileSync('github-stats.svg',     makeStatsCard(user, contrib, repoStats), 'utf8');
  fs.writeFileSync('github-top-langs.svg', makeLangsCard(repoStats.top),            'utf8');

  console.log('github-stats.svg');
  console.log('github-top-langs.svg\n');
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});