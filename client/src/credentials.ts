const NAME = "foxwq_credentials";
const attributes = () =>
  `Path=/; SameSite=Strict${location.protocol === "https:" ? "; Secure" : ""}`;
export function rememberedCredentials(): {
  username: string;
  password: string;
} | null {
  try {
    const entry = document.cookie
      .split("; ")
      .find((value) => value.startsWith(`${NAME}=`));
    if (!entry) return null;
    const value = JSON.parse(decodeURIComponent(entry.slice(NAME.length + 1)));
    if (
      value &&
      typeof value.username === "string" &&
      typeof value.password === "string"
    ) return value;
  } catch {}
  try {
    rememberCredentials("", "", false);
  } catch {}
  return null;
}
export function rememberCredentials(
  username: string,
  password: string,
  remember: boolean,
) {
  const value = remember
    ? encodeURIComponent(JSON.stringify({ username, password }))
    : "";
  document.cookie = `${NAME}=${value}; Max-Age=${remember ? 10 * 365 * 24 * 60 * 60 : 0}; ${attributes()}`;
}
