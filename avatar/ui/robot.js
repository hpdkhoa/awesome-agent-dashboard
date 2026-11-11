// The built-in robot: the avatar a status shows when it has no image of its own, or its image is missing or broken.
// An original drawing (plan b73e97ad p7, the approved preview avatars-preview.png); animated by style.css (rb-*).
// p8 (Optimize, "All 6 fixes"): every moving part is its own HTML layer (a full-size <svg> in a div), so the GPU moves
// it without redrawing; the old version moved <g> parts inside one SVG, which re-ran style and layout 60 times a second.
// Each layer uses the same 120 x 120 viewBox, so the parts sit exactly where the one-SVG drawing had them.
const ROBOT = (() => {
  const svg = (s) => `<svg viewBox="0 0 120 120">${s}</svg>`;
  const L = (cls, s, kids = "") => `<div class="rl ${cls}">${svg(s)}${kids}</div>`;
  const head = (c) => `<rect x="30" y="38" width="60" height="48" rx="12" fill="#0c1c24" stroke="${c}" stroke-width="3"/>` +
    `<line x1="60" y1="38" x2="60" y2="26" stroke="${c}" stroke-width="3"/>`;
  const body = (c) => `<rect x="40" y="88" width="40" height="18" rx="5" fill="#0c1c24" stroke="${c}" stroke-width="2"/>`;
  const blink = (c) => L("rb-blink", `<circle cx="60" cy="23" r="5" fill="${c}"/>`);
  return {
    // body still; eyes scan, antenna blinks, gear spins, keys tap
    in_progress: L("", head("#39ff14") + `<rect x="48" y="72" width="24" height="3" fill="#39ff14"/>` + body("#39ff14"),
      blink("#39ff14") +
      L("rb-scan", `<rect x="42" y="54" width="12" height="9" rx="2" fill="#39ff14"/><rect x="66" y="54" width="12" height="9" rx="2" fill="#39ff14"/>`) +
      L("rb-spin", `<circle cx="96" cy="30" r="9" fill="none" stroke="#39ff14" stroke-width="3" stroke-dasharray="5 3"/>`) +
      L("rb-key", `<rect x="22" y="100" width="18" height="6" fill="#39ff14"/>`) +
      L("rb-key2", `<rect x="80" y="100" width="18" height="6" fill="#39ff14"/>`)),
    // the whole robot bobs (antenna blinking inside it); the tick stays still
    done: L("rb-bob", head("#00e5ff") +
      `<path d="M42 60 q6 -8 12 0 M66 60 q6 -8 12 0" stroke="#00e5ff" stroke-width="3" fill="none"/><path d="M48 70 q12 9 24 0" stroke="#00e5ff" stroke-width="3" fill="none"/>` +
      body("#00e5ff"), blink("#00e5ff")) +
      L("", `<path d="M86 28 l6 7 l12 -14" stroke="#39ff14" stroke-width="4" fill="none"/>`),
    // asleep: still body, two z float up
    offline: L("", head("#8a6a85") + `<circle cx="60" cy="23" r="5" fill="#3a2a35"/>` +
      `<path d="M42 60 h12 M66 60 h12" stroke="#ff2bd6" stroke-width="3"/><path d="M52 72 h16" stroke="#8a6a85" stroke-width="3"/>` + body("#8a6a85")) +
      L("rb-zz", `<text x="84" y="40" fill="#ff2bd6" font-size="16" font-family="Tahoma" font-weight="bold">z</text>`) +
      L("rb-zz2", `<text x="84" y="40" fill="#ff2bd6" font-size="12" font-family="Tahoma" font-weight="bold">z</text>`),
    // alert: the robot and its "!" sign hop
    needs_you: L("rb-hop", head("#ff8a00") +
      `<circle cx="48" cy="58" r="7" fill="#ff8a00"/><circle cx="72" cy="58" r="7" fill="#ff8a00"/><circle cx="48" cy="58" r="3" fill="#000"/><circle cx="72" cy="58" r="3" fill="#000"/><ellipse cx="60" cy="74" rx="5" ry="4" fill="#ff8a00"/>` +
      body("#ff8a00"), blink("#ff8a00")) +
      L("rb-hop", `<rect x="88" y="14" width="22" height="26" rx="6" fill="#ff8a00"/><text x="95" y="34" fill="#000" font-size="18" font-weight="bold" font-family="Tahoma">!</text>`),
  };
})();
