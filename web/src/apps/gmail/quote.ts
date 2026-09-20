/** Splits a plain-text reply into "what the sender wrote" and "the quoted earlier conversation". Pure, no DOM. */
export function splitQuoted(text: string): { main: string; quoted: string } {
  const lines = text.split("\n");
  const cands: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // "On Mon, Jan 1, 2026 at 10:00 AM Ada <ada@x.com> wrote:" (sometimes wrapped so "wrote:" is on the next line)
    if (/^On .{4,300}wrote:\s*$/i.test(l) || (/^On .{4,300}$/i.test(l) && /^\s*wrote:\s*$/i.test(lines[i + 1] ?? ""))) { cands.push(i); break; }
    if (/^-{2,}\s*(Original Message|Forwarded message)\s*-{2,}\s*$/i.test(l)) { cands.push(i); break; }
  }
  // a trailing block made only of "> ..." lines
  let k = lines.length;
  while (k > 0 && (lines[k - 1].trim() === "" || lines[k - 1].startsWith(">"))) k--;
  const firstQuote = lines.findIndex((l, i) => i >= k && l.startsWith(">"));
  if (firstQuote >= 0) cands.push(firstQuote);

  if (!cands.length) return { main: text, quoted: "" };
  const cut = Math.min(...cands);
  const main = lines.slice(0, cut).join("\n").trimEnd();
  if (!main.trim()) return { main: text, quoted: "" }; // never hide the entire message
  return { main, quoted: lines.slice(cut).join("\n").trim() };
}
