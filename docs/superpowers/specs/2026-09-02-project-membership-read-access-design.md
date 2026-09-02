# Project Membership Read Access Design

## Goal

Allow an authenticated user to read a project when they are either the current
project owner or have a `project_memberships` row. Keep every project mutation
authorized exclusively through the existing `projects.owner_user_id` checks.
Frontend work, invitations, membership-management endpoints, and a broader role
system are outside this change.

## Data model

Add `project_memberships` with:

- UUID primary key with `defaultRandom()`;
- required `project_id` and `user_id` foreign keys with cascading deletes;
- required `role` limited by a database check to `viewer` or `owner`;
- required `created_by` foreign key to `users.id`;
- required timezone-aware `created_at` and `updated_at` timestamps;
- a unique index on `(project_id, user_id)`;
- indexes on `user_id` and `project_id`.

The migration backfills one `owner` membership for every existing project whose
`owner_user_id` is non-null, using that owner for both `user_id` and
`created_by`. Existing ownerless legacy projects are deliberately skipped and
remain invisible to ordinary users.

New project creation inserts the owner's membership in the same transaction as
the project. The existing operator flow that assigns an owner to an ownerless
project does the same. There is no owner-reassignment flow today, so this change
does not need membership transfer behavior.

## Read authorization

Introduce one reusable SQL predicate for a user-scoped read:

```text
projects.owner_user_id = user_id
OR EXISTS (
  SELECT 1 FROM project_memberships
  WHERE project_memberships.project_id = projects.id
    AND project_memberships.user_id = user_id
)
```

The predicate is embedded in the data query rather than performed as a separate
preflight check. This keeps project filtering and child-data reads atomic from
the caller's perspective and prevents a membership change between an access
check and an unscoped query from exposing data.

Apply it to:

- `/api/v1/projects` and `/api/v2/projects` lists;
- `/api/v1/projects/:projectId`;
- overview, agents, messages, message detail, and activity/events;
- connection metadata reads.

Operator reads retain their existing unrestricted scope. User-facing missing or
unauthorized projects continue returning the current indistinguishable 404.

For project lists, `projects` and the v2 `default_project` are selected from all
readable projects. `active_count` and `project_limit` remain owner-only creation
quota metadata, so viewer memberships do not consume or inflate the user's
project-creation allowance. The legacy v1 response shape remains unchanged.

## Write authorization

Archive, restore, delete, connection issue/revoke, token operations, and all
other mutations continue checking `projects.owner_user_id`. A viewer membership
never satisfies a write authorization check. This design does not use the
membership `role` as mutation authority; `projects.owner_user_id` remains the
single write-authority source of truth.

## Tests and verification

Use integration tests and a red-green TDD sequence to prove:

- migration shape, constraints, indexes, and backfill for owned projects;
- ownerless legacy projects are skipped;
- new projects and operator-assigned legacy projects get owner memberships;
- a viewer sees a shared project in v1/v2 lists and can read project detail,
  overview, agents, messages, events, and safe connection metadata;
- a user without ownership or membership receives the existing 404;
- a viewer cannot archive, restore, delete, issue/revoke connections, or perform
  other owner-only mutations;
- the owner retains all existing mutation behavior;
- v1 response compatibility, pagination, owner quota counts, and operator reads
  remain intact.

Run the focused control/schema suites first, then backend typecheck, lint, and
the full backend test suite. No frontend files or frontend tests are changed in
this slot.
