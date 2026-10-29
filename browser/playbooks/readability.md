---
title: Readability mode
summary: Turn a cluttered page into a comfortable read with a few CSS rules — measure, type size, line-height, calm colours, de-stuck bars and hidden clutter — without touching consent, login or security UI.
when: the user says a page is hard to read, too busy, too small, or asks for a reader mode, focus mode, or to hide distractions.
command: Make this page easier to read
prompt: Read the "readability" playbook with browser_skill_read, find the main content container of the page I am on (browser_read_page, then browser_style_inspect if available), and apply the playbook's readability override tuned to this page (browser_style_apply if available). Keep the navigation reachable, never hide consent or security elements, and show before and after.
icon: 📖
---
# Readability mode

The aim is a page that reads like a good book page: one column of text at a comfortable size, calm colours, nothing moving or sticking, and the clutter out of the way. A dozen CSS rules, scoped to the page you inspected.

## 1. Find the content

Read the page and pick the element that holds the longest run of paragraphs: usually `main`, `article`, `[role="main"]`, or a class like `.post`, `.entry-content`, `.article-body`. Inspect it to confirm its width and font settings. Everything below is scoped to that container plus the page frame.

## 2. The reading column

```css
/* readability: column */
article, main [class*="content"], .post, .entry-content { max-width: 68ch; margin-inline: auto; padding-inline: 16px; }
```

68 characters is the comfortable measure; on very wide screens the column stays put and the margins grow.

## 3. Type

```css
/* readability: type */
article, .post, .entry-content { font-size: 18px; line-height: 1.65; }
article p, article li { margin-block: 0 .9em; }
article h1 { font-size: 2.25rem; line-height: 1.15; margin-bottom: .5em; }
article h2 { font-size: 1.5rem; line-height: 1.25; margin-top: 1.8em; margin-bottom: .5em; }
article h3 { font-size: 1.2rem; margin-top: 1.5em; }
article img, article video, article figure { max-width: 100%; height: auto; margin-inline: auto; display: block; }
article blockquote { margin-inline: 0; padding-left: 1em; border-left: 3px solid currentColor; opacity: .9; }
article pre { font-size: .9em; overflow: auto; }
```

Keep the site's typeface; a readable size and line-height matter more than a different font. 18px body with 1.65 line-height suits long reads; 17/1.6 suits shorter articles.

## 4. Calm colours

Warm paper and soft ink read better for long stretches than pure white and black:

```css
/* readability: colours */
html, body { background: #fbf8f1 !important; color: #2a2622 !important; }
article a { color: #0b5fa5; text-decoration: underline; text-underline-offset: .15em; }
```

If the user prefers dark, use the dark-mode playbook's surfaces instead (`#16181d` with text at .87 white).

## 5. Un-stick and quiet

Sticky headers, floating share bars and chat bubbles steal space and attention. Prefer making them static over hiding them, so nothing the user needs disappears:

```css
/* readability: nothing sticks */
header, nav, [class*="sticky"], [class*="fixed"], [class*="share"], [class*="toolbar"] { position: static !important; }
[class*="chat"], [class*="widget-launcher"], [class*="intercom"] { display: none !important; }
```

## 6. Hide the clutter — carefully

Hide what is clearly decorative or promotional: sidebars with ads, "recommended" rails, newsletter boxes inside the text, autoplaying video teasers.

```css
/* readability: clutter */
aside, [class*="sidebar"], [class*="related"], [class*="recommend"], [class*="newsletter"], [class*="promo"], [class*="advert"], [id*="ad-"] { display: none !important; }
```

**Never hide**: cookie or consent dialogs, login and account elements, payment or checkout UI, error and warning messages, security notices, legal text, the main navigation's content. Before adding a selector to the hidden list, check what it matches on this page (`browser_find` or an inspection) — a class like `promo` can sit on a checkout button. If the main navigation is in the way, un-stick it instead of hiding it.

## 7. Check

Screenshot before and after. Scroll to the middle of the article and the end: images intact, code blocks readable, nothing important gone, no horizontal scroll. Tell the user exactly what was hidden and that the site keeps this look until they remove it (the styles tool lists and removes overrides by name).

## Variants

- **Focus mode**: the column rule plus hiding everything outside the content container (`body > *:not(:has(article)) { display: none !important }` where `:has` is supported) — show the user how to turn it off.
- **Print-like**: the column plus `font-family: Georgia, serif` for body text, for users who ask for a book feel.
- **Large print**: 20–22px body, line-height 1.7, measure 60ch.

## Checklist

- [ ] One column at 60–70ch, centred
- [ ] Body 17–19px, line-height 1.6–1.7, paragraph spacing
- [ ] Headings on a scale, images fit the column
- [ ] Calm background and ink; links underlined
- [ ] Nothing sticky; decorative clutter hidden; consent, login, payment, errors untouched
- [ ] User told what was hidden and how to reset
