"""Reusable audience and rollout checks for the CLI and localhost button adapter."""
POLICIES = ("public", "workspace", "workspace_managers")


INTERNAL_NEXT_STEP = ("For a prospect or customer: publish a new link with --access public and revoke this one. "
                      "An Internal link cannot be made External.")
AUDIENCE_NOTICES = {
    "public": ("Who can open: External. Anyone with the link, no sign-in.",),
    "workspace": ("Who can open: Internal. Only signed-in people in this workspace. "
                  "Anyone else, including a prospect or customer, is stopped at the Bench sign-in page.",
                  INTERNAL_NEXT_STEP),
    "workspace_managers": ("Who can open: Internal. Only signed-in workspace managers and above. "
                           "Anyone else, including a prospect or customer, is stopped at the Bench sign-in page.",
                           INTERNAL_NEXT_STEP),
}


class PublishControlError(ValueError):
    pass


def select_access(requested=None, saved=None):
    if saved is not None and saved not in POLICIES:
        raise PublishControlError("Unknown saved audience; publishing stopped.")
    access = requested if requested is not None else saved or "workspace"
    if access not in POLICIES:
        raise PublishControlError("Choose public, workspace, or workspace_managers.")
    if saved is not None and access != saved:
        raise PublishControlError("Replacement cannot change audience.")
    return access


def audience_notice(access):
    """Plain lines saying who can open the link, so nobody forwards a sign-in page by mistake."""
    return AUDIENCE_NOTICES[access]


def require_capability(response):
    if (not isinstance(response, dict) or type(response.get("version")) is not int
            or response.get("version") != 3
            or response.get("defaultAccessPolicy") != "workspace"
            or response.get("replacementPreservesAccess") is not True
            or response.get("internalCreatePath") != "/api/bench-share/internal"
            or not isinstance(response.get("accessPolicies"), list)
            or not all(p in response["accessPolicies"] for p in POLICIES)):
        raise PublishControlError("This Bench server has not confirmed Internal publishing support. Nothing was created.")


def create_checked(request_json, endpoint, headers, payload, access=None):
    access = select_access(access)
    # No title, notes or file metadata is sent on this authenticated GET.
    if access != "public":
        require_capability(request_json("GET", endpoint, headers))
    created = request_json("POST", endpoint if access == "public" else endpoint + "/internal", headers, {**payload, "accessPolicy": access})
    if not isinstance(created, dict) or created.get("accessPolicy") != access:
        raise PublishControlError("Server audience echo is missing or mismatched. No files uploaded; inspect/revoke the unfinished link.")
    return created


def replace_checked(request_json, replace_files, endpoint, headers, slug, requested=None, saved=None):
    # Saved audience comes from an authorized mutation preflight, never a default.
    bundle = request_json("GET", endpoint + "/" + slug + "/replace", headers)
    actual = bundle.get("accessPolicy") if isinstance(bundle, dict) else None
    if actual not in POLICIES or saved is not None and saved != actual:
        raise PublishControlError("Saved audience is missing or mismatched. No files sent.")
    access = select_access(requested, actual)
    if access != "public":
        require_capability(request_json("GET", endpoint, headers))
    replaced = replace_files(access)
    if not isinstance(replaced, dict) or replaced.get("accessPolicy") != access:
        raise PublishControlError("Replacement audience echo missing or mismatched.")
    return replaced
