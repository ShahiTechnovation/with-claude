/// <reference path="../.astro/types.d.ts" />

import type { AdminUser } from './server/auth';

declare global {
  namespace App {
    /**
     * Set by `src/middleware.ts` on every request.
     *
     * Present means: a valid session, whose user still exists, is still
     * active, and still holds an admin role — all re-checked against the
     * database this request. A page that has a `user` here does not need to
     * check anything else about them.
     */
    interface Locals {
      user?: AdminUser;
    }
  }
}

export {};
