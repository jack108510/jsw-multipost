#!/usr/bin/env node
const assert = require('assert');

function cleanName(text) {
  const t = (text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^(Unread|Group:|Facebook group:)\s*/i, '')
    .replace(/Last active.*$/i, '')
    .replace(/\b\d+[smhdw]\b.*$/i, '')
    .trim();
  const notificationMatch = t.match(/\bin\s+(.+?):\s*["“]/i);
  if (notificationMatch) return notificationMatch[1].trim();
  const crosspostMatch = t.match(/crossposted to\s+(.+?)(?:\.\s*\d+[smhdw]?|\.?$)/i);
  if (crosspostMatch) return crosspostMatch[1].trim().toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  if (/^[A-Z0-9 &'’/()_-]+$/.test(t) && /[A-Z]/.test(t) && t.length > 6) return t.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  return t;
}

function badName(text) {
  const t = cleanName(text);
  if (t.length < 3 || t.length > 90) return true;
  if (/^\d+$/.test(t)) return true;
  if (/^(new|see all|join|joined|member|members|post|posts|comment|comments|notification|notifications)$/i.test(t)) return true;
  if (/\b(left a comment|commented|shared a post|reacted|posted in|new post|see all|sponsored|crossposted|your post was|make progress|grow your audience|follow a few steps)\b/i.test(t)) return true;
  if (/[.!?]\s+[A-Z0-9].*[.!?]/.test(t)) return true;
  return false;
}

function slugToName(slug) {
  const decoded = decodeURIComponent(slug || '').trim();
  if (/^\d+$/.test(decoded)) return '';
  return decoded
    .replace(/[-_.]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

function chooseName(slug, candidates) {
  const cleaned = candidates.map(cleanName).filter(Boolean);
  const name = cleaned.find(t => !badName(t)) || slugToName(slug);
  return (!name || badName(name)) ? null : name;
}

const cases = [
  {
    name: 'rejects growth prompt on numeric group id instead of saving UI copy',
    slug: '643157445844758',
    candidates: ['UnreadMake progress this week. Follow a few steps to grow your audience.'],
    expected: null
  },
  {
    name: 'uses slug fallback instead of crosspost notification copy',
    slug: 'canadasmallbusinessownersnetwork',
    candidates: ['UnreadYour post was crossposted to CANADA SMALL BUSINESS OWNERS NETWORK.6d'],
    expected: 'Canada Small Business Owners Network'
  },
  {
    name: 'keeps real named local group and strips activity suffix',
    slug: '870072629718006',
    candidates: ['Edmonton Alberta Small business NetworkingLast active 8 minutes ago'],
    expected: 'Edmonton Alberta Small business Networking'
  },
  {
    name: 'normalizes all-caps group names with activity suffix',
    slug: 'canadasmallbusinessownersnetwork',
    candidates: ['CANADA SMALL BUSINESS OWNERS NETWORKLast active a week ago'],
    expected: 'Canada Small Business Owners Network'
  },
  {
    name: 'keeps real slug group when no clean display text exists',
    slug: 'smallbizownersnetworking',
    candidates: ['Joined'],
    expected: 'Smallbizownersnetworking'
  }
];

for (const c of cases) {
  assert.strictEqual(chooseName(c.slug, c.candidates), c.expected, c.name);
}

console.log(`group-name extraction tests passed (${cases.length})`);
