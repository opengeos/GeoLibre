// Side-effect entry point for restoring a deep link after a sign-in redirect.
//
// This exists as its own module purely so the restore happens at *import* time.
// A call in `main.tsx`'s body would run after every one of its imports has been
// evaluated — including `./i18n`, which resolves the UI language from the query
// string while it loads. Importing this above `./i18n` is what puts the query
// back in time to be read. See `auth-return-url.ts` for why.
import { restoreAuthReturnQuery } from "./auth-return-url";

restoreAuthReturnQuery();
