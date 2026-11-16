// Gesture profiles: every web/profiles/*.json. Pure helpers, so `npm test` can check them.
//
// Profile file:
//   {
//     "app": "Chrome",                       name shown on the HUD
//     "panel": true,                         optional: a Jarvis centre panel (Spotify, Files),
//                                            used when Jarvis itself is in front
//     "match": {                             optional: when to switch to it automatically
//       "bundleIds": ["com.google.Chrome"],  front app
//       "hosts": ["youtube.com"]             active browser tab (beats bundleIds; subdomains match)
//     },
//     "gestures": { "<gesture>": <command> } any api.js command, e.g.
//                                            {"action":"key","combo":"ctrl+tab","label":"Next tab"}
//   }

/** The Jarvis page's own hosts: when its tab is in front, the panel profile applies. */
export const JARVIS_HOSTS = new Set(['localhost:5173', '127.0.0.1:5173', '[::1]:5173']);

const bareHost = (h) => String(h ?? '').toLowerCase().replace(/^(?:www|m)\./, '');

/**
 * Profile for the front app, or null (Jarvis itself in front, or no profile matches).
 * @param front    {bundleId, host} from the helper
 * @param profiles array of profile objects
 */
export function profileForFront(front, profiles) {
  if (!front?.bundleId) return null;
  if (JARVIS_HOSTS.has(String(front.host ?? '').toLowerCase())) return null;
  const host = bareHost(front.host);
  if (host) {
    const byHost = profiles.find((p) => p.match?.hosts?.some((h) => host === h || host.endsWith(`.${h}`)));
    if (byHost) return byHost;
  }
  return profiles.find((p) => p.match?.bundleIds?.includes(front.bundleId)) ?? null;
}

/** Problems in a profile file, as readable strings (empty = fine). */
export function checkProfile(p, { gestureNames, isValidCombo = () => true }) {
  const errs = [];
  if (!p?.app || typeof p.app !== 'string') errs.push('missing "app"');
  for (const [g, cmd] of Object.entries(p?.gestures ?? {})) {
    if (!gestureNames.has(g) && !g.startsWith('custom_')) errs.push(`unknown gesture "${g}"`);
    if (!cmd?.action) errs.push(`${g}: missing "action"`);
    if (cmd?.action === 'key' && !isValidCombo(cmd.combo)) errs.push(`${g}: bad combo "${cmd.combo}"`);
  }
  return errs;
}
