// HTML mail is reduced to plain text and never returned as HTML (R12). Shared by Gmail and Outlook.
export function htmlToText(html: string, max: number): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<(br|\/p|\/div|\/tr|\/li)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
}
