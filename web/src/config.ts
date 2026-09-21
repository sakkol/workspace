// The ONLY file you need to edit to change the quick links and the extra clocks on the workspace page.
// After editing: commit and push; the site rebuilds itself.
//
// SAFETY NOTE: links open the real websites in a new tab. If a site asks you to sign in, do that only on a computer
// you trust: the whole point of this workspace is to avoid typing passwords on shared computers. Prefer links that work
// without signing in. Only https:// links are shown; anything else is ignored.

export interface QuickLink { name: string; url: string; icon?: string }

export const QUICK_LINKS: QuickLink[] = [
  { name: "Website", url: "https://sakkol.github.io/", icon: "🙋‍♂️" },
  { name: "Github", url: "https://github.com/sakkol/", icon: "🎯" },
  { name: "sEEG Map", url: "https://seegmap.github.io/", icon: "📍" },
  { name: "Box", url: "https://duke.app.box.com/folder/0", icon: "📦" },
  { name: "Citrix", url: "https://citrix.duke.edu/Citrix/FASWeb/", icon: "🩺" },
  { name: "Google Maps", url: "https://maps.google.com/", icon: "🗺️" },
  { name: "Translate", url: "https://translate.google.com/", icon: "🗣️" },
  { name: "GoToMyPC", url: "https://www.gotomypc.com/en_US/members/myComputers.tmpl", icon: "🌐" }
];

export interface ExtraClock { label: string; timeZone: string }

// Extra clocks shown under the main clock, using IANA time zone names, for example:
//   { label: "Istanbul", timeZone: "Europe/Istanbul" },
//   { label: "New York", timeZone: "America/New_York" },
//   { label: "Chicago", timeZone: "America/Chicago" },
export const EXTRA_CLOCKS: ExtraClock[] = [];
