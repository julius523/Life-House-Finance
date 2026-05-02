// Orval emits both runtime zod schemas (`generated/api.ts`) and
// TypeScript interfaces (`generated/types/`) under identical names —
// e.g. `LoginBody` exists as `const LoginBody = zod.object(...)` in
// api.ts AND as `interface LoginBody` in types/loginBody.ts.
//
// Re-exporting both barrels with `export *` collides on those names
// (TypeScript treats `export type *` as occupying the same export
// namespace as `export *`, so `export type *` does not resolve the
// collision either).
//
// All known consumers of `@workspace/api-zod` import value-side
// (zod schema) names from `generated/api.ts`. Type-only names that
// have no zod counterpart are sourced from `@workspace/api-client-react`
// instead, which has its own non-conflicting types barrel. So we only
// re-export the api.ts barrel here. If a future caller needs a pure
// type from `generated/types`, add an explicit `export type { Name }`
// re-export below.
export * from "./generated/api";
