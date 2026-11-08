import json
import os
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from publish_control import PublishControlError, create_checked, select_access

CAPABILITY = {"version": 3, "internalCreatePath": "/api/bench-share/internal", "accessPolicies": ["public", "workspace", "workspace_managers"],
              "defaultAccessPolicy": "workspace", "replacementPreservesAccess": True}
SLUG = "A" * 22


class PublishControlTests(unittest.TestCase):
    def exercise_helper(self, capability, echo="workspace"):
        import publish
        calls = []
        def request(method, url, headers, payload=None):
            calls.append((method, url, headers, payload))
            if method == "GET":
                if isinstance(capability, Exception):
                    raise capability
                return capability
            return {"slug": SLUG, "accessPolicy": echo}
        with tempfile.TemporaryDirectory() as tmp:
            page = Path(tmp) / "index.html"
            page.write_text("<h1>private fixture</h1>")
            with patch.object(publish, "request_json", side_effect=request), patch.object(publish, "upload_file") as upload, \
                    patch.object(publish, "auth_headers", return_value={"Authorization": "Bearer fixture"}), \
                    patch.object(publish, "base_url", return_value="https://fixture.invalid"):
                try:
                    publish.publish(page, "Private fixture", None, False)
                    error = None
                except (PublishControlError, publish.LinkError) as exc:
                    error = exc
                return calls, upload.call_count, error

    def published_output(self, access):
        import publish
        def request(method, url, headers, payload=None):
            return CAPABILITY if method == "GET" else {"slug": SLUG, "accessPolicy": access or "workspace"}
        out = StringIO()
        with tempfile.TemporaryDirectory() as tmp:
            page = Path(tmp) / "index.html"
            page.write_text("<h1>fixture</h1>")
            with patch.object(publish, "request_json", side_effect=request), patch.object(publish, "upload_file"), \
                    patch.object(publish, "auth_headers", return_value={"Authorization": "Bearer fixture"}), \
                    patch.object(publish, "base_url", return_value="https://fixture.invalid"), redirect_stdout(out):
                publish.publish(page, "Fixture", None, False, access)
        return out.getvalue()

    def replaced_output(self, access):
        import publish
        out = StringIO()
        with tempfile.TemporaryDirectory() as tmp:
            page = Path(tmp) / "index.html"
            page.write_text("<h1>fixture</h1>")
            def request(method, url, headers, payload=None):
                return {"accessPolicy": access} if url.endswith("/replace") else CAPABILITY
            with patch.object(publish, "request_json", side_effect=request), \
                    patch.object(publish, "replace_files", return_value={"accessPolicy": access}), \
                    patch.object(publish, "auth_headers", return_value={"Authorization": "Bearer fixture"}), \
                    patch.object(publish, "base_url", return_value="https://fixture.invalid"), redirect_stdout(out):
                publish.replace(page, SLUG, access)
        return out.getvalue()

    def test_published_output_says_who_can_open_the_link(self):
        external = self.published_output("public")
        self.assertIn("Who can open: External. Anyone with the link, no sign-in.", external)
        self.assertNotIn("sign-in page", external)
        for access in (None, "workspace", "workspace_managers"):
            with self.subTest(access=access):
                internal = self.published_output(access)
                self.assertIn("Who can open: Internal.", internal)
                self.assertIn("stopped at the Bench sign-in page", internal)
                self.assertIn("--access public", internal)

    def test_replaced_output_says_who_can_open_the_link(self):
        for access in ("public", "workspace", "workspace_managers"):
            with self.subTest(access=access):
                output = self.replaced_output(access)
                self.assertIn("Who can open:", output)
                if access == "public":
                    self.assertIn("External. Anyone with the link, no sign-in.", output)
                    self.assertNotIn("sign-in page", output)
                else:
                    self.assertIn("Internal.", output)
                    self.assertIn("stopped at the Bench sign-in page", output)
                    self.assertIn("--access public", output)

    def test_command_and_skill_do_not_promise_every_link_opens_without_sign_in(self):
        plugin = Path(__file__).resolve().parents[3]
        command = (plugin / "commands" / "link.md").read_text()
        skill = (plugin / "skills" / "link" / "SKILL.md").read_text()
        for name, text in (("command", command), ("skill", skill)):
            with self.subTest(name=name):
                self.assertNotIn("Anyone with the URL can open it without logging in", text)
                self.assertNotIn("Recipients do not log in", text)
                self.assertIn("--access public", text)
                self.assertRegex(text, "prospect")

    def test_both_plugin_manifests_ship_the_same_version(self):
        plugin = Path(__file__).resolve().parents[3]
        versions = {json.loads(path.read_text())["version"]
                    for path in (plugin / "plugin.json", plugin / ".claude-plugin" / "plugin.json")}
        self.assertEqual(len(versions), 1)

    def test_old_unknown_malformed_unauthorized_fail_before_metadata(self):
        for value in ({}, [], None, {**CAPABILITY, "version": 1}, {**CAPABILITY, "version": True},
                      {**CAPABILITY, "accessPolicies": "workspace"}, PermissionError("unauthorized")):
            if isinstance(value, PermissionError):
                import publish
                value = publish.LinkError("unauthorized")
            with self.subTest(value=value):
                calls, uploads, error = self.exercise_helper(value)
                self.assertIsNotNone(error)
                self.assertEqual([c[0] for c in calls], ["GET"])
                self.assertIsNone(calls[0][3])
                self.assertEqual(calls[0][2], {"Authorization": "Bearer fixture"})
                self.assertEqual(uploads, 0)

    def test_get_create_echo_then_upload(self):
        calls, uploads, error = self.exercise_helper(CAPABILITY)
        self.assertIsNone(error)
        self.assertEqual([c[0] for c in calls], ["GET", "POST"])
        self.assertEqual(calls[1][3]["accessPolicy"], "workspace")
        self.assertEqual(uploads, 1)
        self.assertTrue(calls[1][1].endswith("/api/bench-share/internal"))

    def test_supported_capability_then_old_internal_endpoint_never_uses_legacy_create(self):
        for status in (404, 405):
            calls = []
            def request(method, url, headers, payload=None):
                calls.append((method, url))
                if method == "GET":
                    return CAPABILITY
                raise PublishControlError(str(status))
            with self.assertRaises(PublishControlError):
                create_checked(request, "https://fixture.invalid/api/bench-share", {}, {"title": "fixture"})
            self.assertEqual(calls, [("GET", "https://fixture.invalid/api/bench-share"), ("POST", "https://fixture.invalid/api/bench-share/internal")])

    def test_missing_or_wrong_echo_never_uploads(self):
        for echo in (None, "public", "workspace_managers", "unknown"):
            calls, uploads, error = self.exercise_helper(CAPABILITY, echo)
            self.assertEqual([c[0] for c in calls], ["GET", "POST"])
            self.assertIsNotNone(error)
            self.assertEqual(uploads, 0)

    def test_replacement_keeps_saved_policy(self):
        self.assertEqual(select_access(saved="public"), "public")
        self.assertEqual(select_access(), "workspace")
        for requested in ("public", "unknown", "master_admin"):
            with self.assertRaises(PublishControlError):
                select_access(requested, "workspace")

    def test_actual_helper_replaces_only_after_saved_policy_and_capability(self):
        import publish
        for requested in (None, "workspace", "public"):
            calls = []
            def request(method, url, headers, payload=None):
                calls.append((method, url))
                return {"accessPolicy": "workspace"} if url.endswith("/replace") else CAPABILITY
            def send(url, headers, staged, files, audience):
                calls.append(("REPLACE", url))
                self.assertEqual(audience, "workspace")
                self.assertEqual(files, ["index.html"])
                return {"accessPolicy": audience}
            with tempfile.TemporaryDirectory() as tmp:
                page = Path(tmp) / "index.html"
                page.write_text("<h1>Fixture</h1>")
                with patch.object(publish, "request_json", side_effect=request), patch.object(publish, "replace_files", side_effect=send), patch.object(publish, "auth_headers", return_value={"Authorization": "Bearer fixture"}), patch.object(publish, "base_url", return_value="https://fixture.invalid"), redirect_stdout(StringIO()):
                    if requested == "public":
                        with self.assertRaises(PublishControlError):
                            publish.replace(page, SLUG, requested)
                        self.assertEqual([c[0] for c in calls], ["GET"])
                    else:
                        publish.replace(page, SLUG, requested)
                        self.assertEqual([c[0] for c in calls], ["GET", "GET", "REPLACE"])
                    self.assertTrue(calls[0][1].endswith("/replace"))

    def test_button_control_request_order_and_saved_audience(self):
        module = str(Path(__file__).with_name("publish-control.js"))
        code = r'''
const assert = require('node:assert/strict');
const { publish, selectAccess, mount } = require(process.argv[1]);
const capability = JSON.parse(process.argv[2]);
(async () => {
 for (const value of [{}, null, { ...capability, version: 1 }, { ...capability, accessPolicies: 'workspace' }]) {
  const calls = [];
  await assert.rejects(publish({ payload: { title: 'private' }, request: async (method, path, body) => { calls.push([method, path, body]); return value; }, upload: async () => calls.push(['UPLOAD']) }));
  assert.deepEqual(calls, [['GET', '/api/bench-share', undefined]]);
 }
 for (const echo of [undefined, 'public', 'workspace']) {
  const calls = [];
  const operation = publish({ payload: { title: 'private' }, request: async (method, path, body) => { calls.push(method); return method === 'GET' ? capability : { slug: 'A'.repeat(22), accessPolicy: echo }; }, upload: async () => { calls.push('UPLOAD'); } });
  if (echo === 'workspace') { assert.equal((await operation).url, '/s/' + 'A'.repeat(22)); assert.deepEqual(calls, ['GET', 'POST', 'UPLOAD']); }
  else { await assert.rejects(operation); assert.deepEqual(calls, ['GET', 'POST']); }
 }
 for (const status of [404, 405]) {
  const calls = [];
  await assert.rejects(publish({ payload: { title: 'private' }, request: async (method, path) => { calls.push([method, path]); if (method === 'GET') return capability; throw Error(String(status)); }, upload: async () => assert.fail('no upload') }));
  assert.deepEqual(calls, [['GET', '/api/bench-share'], ['POST', '/api/bench-share/internal']]);
 }
 assert.throws(() => selectAccess('public', 'workspace'));
 let replaced = false;
 const result = await publish({ slug: 'A'.repeat(22), savedAccess: 'workspace_managers', request: async (method, path) => { assert.equal(method, 'GET'); return path.endsWith('/replace') ? { accessPolicy: 'workspace_managers' } : capability; }, replace: async (slug, audience) => { assert.equal(audience, 'workspace_managers'); replaced = true; return { accessPolicy: audience }; } });
 assert(replaced); assert.equal(result.accessPolicy, 'workspace_managers');
 // Exercise the actual DOM control's click path with a minimal DOM boundary.
 global.document = { createElement: tag => ({ tag, children: [], append(...values) { this.children.push(...values); }, setAttribute() {}, addEventListener(name, handler) { this.click = handler; } }) };
 const container = document.createElement('div'); let creates = 0;
 const control = mount(container, { payload: { title: 'fixture' }, request: async method => { if (method === 'GET') return {}; creates++; } });
 assert.equal(control.select.value, 'workspace'); assert.equal(container.children[0].textContent, 'Audience ');
 await control.button.click(); assert.equal(creates, 0); assert.match(control.status.textContent, /unconfirmed/);
 for (const access of ['workspace', 'workspace_managers', 'public']) {
  const mounted = mount(document.createElement('div'), { access, payload: { title: 'fixture' },
   request: async method => method === 'GET' ? capability : { slug: 'A'.repeat(22), accessPolicy: access }, upload: async () => {} });
  await mounted.button.click();
  const links = mounted.status.children.filter(child => child.tag === 'a');
  assert.deepEqual(links.map(link => link.textContent), ['Look', 'Forward']);
  assert.equal(links[0].href, access === 'public' ? '/api/bench-share/' + 'A'.repeat(22) + '/asset/index.html' : '/app/bench-pages/' + 'A'.repeat(22));
  assert.equal(links[1].href, '/s/' + 'A'.repeat(22));
  assert(links.every(link => link.target === '_blank' && link.rel === 'noopener noreferrer'));
 }

})().catch(error => { console.error(error); process.exitCode = 1; });
'''
        result = subprocess.run(["node", "-e", code, module, json.dumps(CAPABILITY)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)



class CompanyLoginTests(unittest.TestCase):
    """#17232: on a Mac with two companies, /link reads only the company's own login."""

    AUTH_ENV = ("BENCH_COWORK_CONFIG", "BENCH_API_KEY", "BENCH_AUTH_TOKEN", "BENCH_COWORK_TOKEN",
                "BENCH_API_BASE_URL", "BENCH_API_BASE")

    def seat_home(self, registry):
        """A HOME whose ~/.claude holds the primary company's login, plus `registry` records."""
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        home = Path(directory.name)
        self.write_login(home / ".claude" / "config" / "bench-cowork.json", "primary-token", "https://primary.invalid")
        if registry is not None:
            (home / ".aurelius" / "profile-registry").mkdir(parents=True)
            for name, record in registry.items():
                text = record if isinstance(record, str) else json.dumps(record)
                (home / ".aurelius" / "profile-registry" / name).write_text(text)
        env = {key: value for key, value in os.environ.items() if key not in self.AUTH_ENV}
        environment = patch.dict(os.environ, {**env, "HOME": str(home)}, clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        return home

    @staticmethod
    def write_login(path, token, base):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"bench_cowork_token": token, "bench_api_base": base}))

    def company_login(self, home):
        path = home / ".aurelius" / "profiles" / "company-alpha" / "claude" / "config" / "bench-cowork.json"
        self.write_login(path, "alpha-token", "https://alpha.invalid")
        return path

    def assert_signed_out(self, reason="BENCH_COWORK_CONFIG is not set"):
        import publish
        with self.assertRaises(publish.LinkError) as raised:
            publish.auth_headers()
        self.assertIn("signed out of Bench", str(raised.exception))
        self.assertIn(reason, str(raised.exception))
        self.assertEqual(publish.base_url(), publish.DEFAULT_BASE)

    ISOLATED = {"company-alpha.json": {"profileId": "company-alpha", "isolation": "profile"}}

    def test_named_company_login_is_used(self):
        import publish
        home = self.seat_home(self.ISOLATED)
        os.environ["BENCH_COWORK_CONFIG"] = str(self.company_login(home))
        self.assertEqual(publish.auth_headers(), {"Authorization": "Bearer alpha-token"})
        self.assertEqual(publish.base_url(), "https://alpha.invalid")

    def test_unnamed_login_with_an_isolated_company_refuses_and_sends_nothing(self):
        import publish
        home = self.seat_home(self.ISOLATED)
        self.company_login(home)
        self.assert_signed_out()
        with tempfile.TemporaryDirectory() as tmp:
            page = Path(tmp) / "index.html"
            page.write_text("<h1>fixture</h1>")
            with patch.object(publish, "request_json") as request, patch.object(publish, "upload_file") as upload, \
                    patch.object(publish, "replace_files") as replace_files, redirect_stdout(StringIO()):
                for send in (lambda: publish.publish(page, "Fixture", None, False),
                             lambda: publish.replace(page, SLUG), lambda: publish.revoke(SLUG)):
                    with self.assertRaisesRegex(publish.LinkError, "signed out of Bench"):
                        send()
            self.assertEqual((request.call_count, upload.call_count, replace_files.call_count), (0, 0, 0))

    def test_unreadable_registry_records_refuse_the_claude_login(self):
        for label, record in (("not JSON", "{not json"), ("not an object", "null"),
                              ("over 64 KB", json.dumps({"pad": "x" * 65536}))):
            with self.subTest(record=label):
                self.seat_home({"company-alpha.json": record})
                self.assert_signed_out()
        for kind in ("symlink", "fifo", "directory"):
            with self.subTest(record=kind):
                home = self.seat_home({})
                record = home / ".aurelius" / "profile-registry" / "company-alpha.json"
                if kind == "symlink":
                    target = home / "company-primary.json"
                    target.write_text(json.dumps({"profileId": "company-primary"}))
                    record.symlink_to(target)
                elif kind == "fifo":
                    os.mkfifo(record)
                else:
                    record.mkdir()
                self.assert_signed_out()

    def test_relative_named_login_is_refused(self):
        self.seat_home(None)
        os.environ["BENCH_COWORK_CONFIG"] = "config/bench-cowork.json"
        self.assert_signed_out("must be an absolute path")

    def test_claude_login_is_kept_without_a_separate_company(self):
        import publish
        for label, registry in (("no registry", None), ("empty registry", {}),
                                ("only a ~/.claude company", {"company-primary.json": {"profileId": "company-primary"}}),
                                ("files that are not records", {"README.md": "{", "Company-Alpha.json": "{"})):
            with self.subTest(registry=label):
                self.seat_home(registry)
                self.assertEqual(publish.auth_headers(), {"Authorization": "Bearer primary-token"})
                self.assertEqual(publish.base_url(), "https://primary.invalid")

    def test_an_exported_token_still_works_when_the_file_login_is_refused(self):
        import publish
        self.seat_home(self.ISOLATED)
        os.environ["BENCH_COWORK_TOKEN"] = "exported-token"
        self.assertEqual(publish.auth_headers(), {"Authorization": "Bearer exported-token"})


if __name__ == "__main__":
    unittest.main()
