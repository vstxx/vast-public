# Default Workspace Onboarding Spec

Current Vast profiles keep their existing workspaces. This pass does not delete or rename any workspace data.

For a future public first-run flow, offer a choice before creating template workspaces:

- Start blank
- Productivity template
- Power-user template
- Choose individual templates: School, Coding, Research, Travel, Gaming

Implementation constraints:

- Only run for brand-new profiles with no stored workspace data.
- Keep JSON import/export compatible.
- Do not create personal-sounding defaults without user confirmation.
- Add tests that existing profiles are not modified and fresh profile template choices produce deterministic workspace sets.

This is intentionally a future onboarding change, not a storage migration.
