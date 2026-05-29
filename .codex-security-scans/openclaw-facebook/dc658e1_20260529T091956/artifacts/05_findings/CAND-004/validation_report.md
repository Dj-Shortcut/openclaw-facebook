# CAND-004 Validation

`apps/image-gen/server/_core/dataDeletionService.ts:25-39` catches and logs `storageDelete` failures. `deleteUserData` then unconditionally calls `clearUserState(psid)` at `:71`, which can erase pending deletion state recorded by `faceMemory.ts`.
