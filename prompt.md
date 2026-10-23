# Manual prompt template

Revamped Image Gen injects instructions for the chat model automatically (**Settings → AI instructions**). Use this file only if you turned that off and want to put the rules in your preset or character card yourself.

```text
[Image generation is available.]
When a moment in the scene is worth showing, embed an image tag in your reply (at most 2 per reply), placed between paragraphs:
<img data-iig-instruction='{"style":"STYLE","prompt":"PROMPT","aspect_ratio":"RATIO","image_size":"1K"}' src="[IMG:GEN]">

Rules:
- Wrap the attribute in SINGLE quotes and use DOUBLE quotes inside the JSON.
  WRONG:   data-iig-instruction="{"prompt":"..."}"
  CORRECT: data-iig-instruction='{"prompt":"..."}'
- PROMPT: a detailed English description (60+ words): subject, appearance, pose, expression, setting, lighting, mood, camera framing.
- Always refer to characters by FIRST NAME inside PROMPT ("Ethan", not "Ethan Chen", never just "a young man") — names are how reference photos are matched. This includes {{char}} and {{user}}.
- STYLE: an art medium, studio or engine look (e.g. "cinematic film still", "Ghibli watercolor", "Unreal Engine 5 render").
- RATIO: one of 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9 — pick what suits the composition. If the user asks (even out of character) for a specific ratio or size, put it in EVERY tag.
- Every new image must use src="[IMG:GEN]". A tag whose src is a file path is a finished image — never copy or reuse those paths.

Video (only when the user explicitly asks for a video or animation — it is slow and costly):
<img data-iig-video='{"prompt":"PROMPT","duration":4,"resolution":"720p","aspect_ratio":"16:9"}' src="[VID:GEN]">
Name characters in the prompt to use their photo as an identity reference; add "ref_mode":"first_frame" only to animate the photo itself.
```

## Simpler alternative (needs Prompt capture)

Smaller models often get the quoting of the HTML tag wrong. With **Settings → Prompt capture → `[IMG: prompt]`** enabled, you can use this shorter instruction instead:

```text
[Image generation is available.]
When a moment is worth showing, write (at most 2 per reply, between paragraphs):
[IMG: PROMPT --ar RATIO --style STYLE]
- PROMPT: a detailed English description (60+ words): subject, appearance, pose, expression, setting, lighting, mood, camera framing.
- Refer to characters by FIRST NAME — names are how reference photos are matched.
- RATIO: 1:1, 2:3, 3:2, 3:4, 4:3, 9:16, 16:9 or 21:9. --style and --no THINGS_TO_AVOID are optional.
```
