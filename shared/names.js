const ADJECTIVES = ["Swift", "Quiet", "Bright", "Brave", "Calm", "Lucky", "Clever", "Gentle", "Bold", "Merry", "Nimble", "Sunny"];
const ANIMALS = ["Otter", "Falcon", "Panda", "Fox", "Heron", "Koala", "Lynx", "Robin", "Seal", "Tiger", "Wren", "Yak"];

function platform() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Mac/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  if (/Linux/.test(ua)) return "Linux";
  return "Browser";
}

function pick(list) {
  return list[crypto.getRandomValues(new Uint32Array(1))[0] % list.length];
}

// Stable per browser when storage works, fresh per tab otherwise.
export function deviceName() {
  const key = "tosstome:name";
  try {
    const saved = localStorage.getItem(key);
    if (saved) return saved;
  } catch {}
  const name = `${pick(ADJECTIVES)} ${pick(ANIMALS)} (${platform()})`;
  try {
    localStorage.setItem(key, name);
  } catch {}
  return name;
}
