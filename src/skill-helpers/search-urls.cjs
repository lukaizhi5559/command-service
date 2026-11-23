'use strict';
// Query-addressable search URLs — navigating IS the acquire step for
// catalog sites. Shared by screen.task (open the search URL directly at
// setup) and screen.act (in-tab acquire fallback). Keyed by host.
const SEARCH_URL_TEMPLATES = {
  'open.spotify.com': 'https://open.spotify.com/search/{q}',
  'amazon.com': 'https://www.amazon.com/s?k={q}',
  'www.amazon.com': 'https://www.amazon.com/s?k={q}',
  'youtube.com': 'https://www.youtube.com/results?search_query={q}',
  'www.youtube.com': 'https://www.youtube.com/results?search_query={q}',
  'music.youtube.com': 'https://music.youtube.com/search?q={q}',
  'google.com': 'https://www.google.com/search?q={q}',
  'www.google.com': 'https://www.google.com/search?q={q}',
  'github.com': 'https://github.com/search?q={q}',
  'stackoverflow.com': 'https://stackoverflow.com/search?q={q}',
  'reddit.com': 'https://www.reddit.com/search/?q={q}',
  'ebay.com': 'https://www.ebay.com/sch/i.html?_nkw={q}',
};

// "a song from artist Lecrae" → "Lecrae" — strip the catalog-noun wrapper
// so the search field/URL gets the proper noun, not the full phrase.
function cleanEntity(t) {
  return String(t || '').trim()
    .replace(/^(a|an|some|the|any)\s+(songs?|tracks?|episodes?|videos?|items?|results?|posts?|photos?|files?)\s+(from|by|of|on|in)\s+(artist|band|show|channel|user|author)\s+/i, '')
    .replace(/^(a|an|some|the|any)\s+(songs?|tracks?|episodes?|videos?|items?|results?|posts?|photos?|files?)\s+(from|by|of)\s+/i, '')
    .trim();
}

// Kind-filtered search sections — a container-typed query ("playlist")
// lands on a filtered results view so same-named songs/albums never enter
// the candidate set. Path segment is appended AFTER the query (Spotify
// routes /search/:q/:section).
const SEARCH_SECTION_PATHS = {
  'open.spotify.com': {
    playlist: 'playlists', album: 'albums', artist: 'artists',
    track: 'tracks', song: 'tracks', show: 'shows', episode: 'episodes',
  },
};

function searchUrlFor(hostOrUrl, q, kind) {
  const host = String(hostOrUrl || '')
    .replace(/^https?:\/\//, '').split('/')[0];
  const bare = host.replace(/^www\./, '');
  const tpl = SEARCH_URL_TEMPLATES[host] || SEARCH_URL_TEMPLATES[bare];
  if (!tpl) return null;
  const url = tpl.replace('{q}', encodeURIComponent(q));
  const section = kind && (SEARCH_SECTION_PATHS[host] || SEARCH_SECTION_PATHS[bare] || {})[kind];
  return section ? `${url}/${section}` : url;
}

module.exports = { SEARCH_URL_TEMPLATES, cleanEntity, searchUrlFor };
