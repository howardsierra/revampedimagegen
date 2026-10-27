/*
 * Revamped Image Gen — SillyTavern extension
 * Copyright (C) 2026 howardsierra
 *
 * Based on notsosillynotsoimages by aceeenvw
 * https://github.com/aceeenvw/notsosillynotsoimages
 * Original: SillyImages by 0xl0cal — https://github.com/0xl0cal/sillyimages
 *
 * Licensed under AGPL-3.0-or-later. See LICENSE.
 */

export const MODULE = 'revamped_image_gen';
export const VERSION = '1.0.0';
export const DISPLAY_NAME = 'Revamped Image Gen';

// Settings key used by notsosillynotsoimages; read only for one-click import.
export const LEGACY_MODULE = 'inline_image_gen';

export const ASPECT_RATIOS = Object.freeze(['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']);
export const IMAGE_SIZES = Object.freeze(['1K', '2K', '4K']);
export const VIDEO_RESOLUTIONS = Object.freeze(['480p', '720p', '1080p', '4K']);

// Folder (under user/images) for reference photos. Same as the original
// extension so imported references keep working without re-uploading.
export const REFS_FOLDER = 'iig_refs';

export const REF_INSTRUCTION = '[The attached reference image(s) show the exact appearance of the named character(s). Keep their face structure, eye colour, hair colour and style, skin tone, body type, outfit and distinctive features consistent with the references.]';

export const DEFAULT_STYLES = Object.freeze([
    { name: 'Cinematic', value: 'cinematic film still, dramatic lighting, shallow depth of field, 35mm' },
    { name: 'Anime', value: 'high quality anime illustration, clean line art, cel shading' },
    { name: 'Semi-real', value: 'semi-realistic digital painting, soft rendering, detailed' },
    { name: 'Painterly', value: 'oil painting, visible brush strokes, rich colour' },
    { name: 'Watercolor', value: 'watercolor illustration, soft washes, paper texture' },
    { name: 'Photo', value: 'photorealistic, natural light, 50mm photograph' },
]);

// Earlier default templates, upgraded in place when the user never edited them.
export const OLD_INJECT_TEMPLATES = [`[Image generation is available.]
When a moment in the scene is worth showing, request an image in your reply, at most {{iig_max}} per reply.
{{iig_format}}
- PROMPT: a detailed English description (60+ words) of subject, pose, expression, setting, lighting, mood and camera framing.
- Always refer to characters by FIRST NAME inside PROMPT so reference photos can be matched. Known characters with references: {{iig_names}}.`];

export const DEFAULT_INJECT_TEMPLATE = `[Image generation is available.]
When a moment in the scene is worth showing, request an image in your reply, at most {{iig_max}} per reply.
{{iig_format}}
- PROMPT: a detailed English description (60+ words) of subject, pose, expression, setting, lighting, mood and camera framing, matching what is happening right now in the story.
- Always refer to characters by FIRST NAME inside PROMPT so reference photos can be matched. Known characters with references: {{iig_names}}.
{{iig_examples}}`;

export const SCENE_PROMPT_TEMPLATE = `[Pause the roleplay. Write ONE image-generation prompt that illustrates the latest moment of the scene below. Output only the prompt — no preamble, no quotes, no markdown.
Requirements: English, 60–120 words; describe subject, appearance, pose, expression, setting, lighting, mood and camera framing; refer to characters by their first name ({{iig_names}}).
{{iig_examples}}]

Scene so far:
{{iig_context}}

Moment to illustrate:
{{iig_scene}}`;

