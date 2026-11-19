// The published "openclaw" package ships no type definitions for these plugin SDK modules
// (upstream type-checks against the sources in the OpenClaw monorepo).
// These are minimal signatures derived from their use, kept deliberately narrow, and will
// be replaced once OpenClaw publishes types or the call sites are reworked.

declare module "openclaw/plugin-sdk/provider-http" {
  export function readProviderJsonResponse<T = unknown>(
    response: Response,
    label: string,
    options?: Record<string, unknown>,
  ): Promise<T>;
  export function readProviderTextResponse(
    response: Response,
    label: string,
    options?: Record<string, unknown>,
  ): Promise<string>;
}

declare module "openclaw/plugin-sdk/text-utility-runtime" {
  export function safeParseJson<T = unknown>(raw: string): T | undefined;
  export function truncateUtf16Safe(value: string, maxChars: number): string;
  export function truncateUtf8Prefix(value: string, maxBytes: number): string;
}

declare module "openclaw/plugin-sdk/number-runtime" {
  export function parseStrictNonNegativeInteger(value: unknown): number | undefined;
  export function parseStrictPositiveInteger(value: unknown): number | undefined;
}

declare module "openclaw/plugin-sdk/node-crypto-runtime" {
  export function sha256Hex(value: string | Uint8Array): string;
}

declare module "openclaw/plugin-sdk/secret-file-runtime" {
  // The caller validates the return shape.
  export function tryReadSecretFileSync(...args: unknown[]): any;
}

declare module "openclaw/plugin-sdk/string-normalization-runtime" {
  export function containsAsciiControlCharacter(value: string): boolean;
}

declare module "openclaw/plugin-sdk/markdown-table-runtime" {
  export function resolveMarkdownTableMode(params: Record<string, unknown>): any;
}

declare module "openclaw/plugin-sdk/context-visibility-runtime" {
  export function resolveChannelContextVisibilityMode(params: Record<string, unknown>): any;
}

declare module "openclaw/plugin-sdk/channel-targets" {
  export function buildChannelKeyCandidates(...args: unknown[]): string[];
  export function normalizeChannelSlug(value: string): string;
  export function resolveChannelEntryMatchWithFallback(params: Record<string, unknown>): any;
}

declare module "openclaw/plugin-sdk/outbound-media" {
  export function loadOutboundMediaFromUrl(url: string, options?: Record<string, unknown>): Promise<any>;
}

declare module "openclaw/plugin-sdk/runtime-doctor-migrations" {
  export const defineChannelAliasMigration: any;
}
declare module "openclaw/plugin-sdk/expect-runtime";
