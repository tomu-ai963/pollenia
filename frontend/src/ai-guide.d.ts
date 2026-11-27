// ai-guide.js の型（worker/test から読むぶんだけ）
export const AI_GUIDE_URL: string;
export const AI_GUIDE_PROMPTS: Record<'login' | 'app', string>;
export const AI_GUIDE_COPIED: string;
export const AI_GUIDE_COPY_FAILED: string;
export function promptFor(kind: string): string | null;
export function initAiGuide(root?: ParentNode): void;
