"""One serialized deployment: existing immutable ASG releases + changed theme files.

Operational identifiers and bootstrap/environment values stay in private AWS storage.
There are no schema migrations, customer mutations or production secrets in CI.
"""

import base64
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.request

OUT = Path("output/cicd")
THEME = "themes/kpurpleshoes-theme"
APP = "shopify/bta-proxy"
STATE_KEY = "releases/cicd/production/state.json"


def require_env(names):
    missing = [name for name in names if not os.environ.get(name)]
    if missing:
        raise RuntimeError("Required configuration is missing: " + ", ".join(missing))


def git(*args):
    return subprocess.check_output(["git", *args])


def changes(previous, current, prefix):
    assert re.fullmatch(r"[a-f0-9]{40}", previous) and re.fullmatch(r"[a-f0-9]{40}", current)
    paths = git("diff", "--name-only", "-z", previous, current, "--", prefix).decode().split("\0")
    return [path for path in paths if path]


def canonical(name, raw):
    if not name.endswith((".json", ".liquid", ".js", ".mjs", ".css", ".svg", ".txt", ".map")):
        return hashlib.sha256(raw).hexdigest()
    text = raw.decode("utf-8-sig").replace("\r\n", "\n")
    if name.endswith(".json"):
        value = json.loads(re.sub(r"^\s*/\*[\s\S]*?\*/", "", text))
        if name in ("templates/page.json", "templates/page.signinstep1.json"):
            # Shopify removes these retired settings, absent from main-coupons' schema and UI.
            for section in value.get("sections", {}).values():
                if section.get("type") == "main-coupons":
                    for key in ("tab_orders", "tab_coupons", "tab_help"):
                        section.get("settings", {}).pop(key, None)
        return json.dumps(value, sort_keys=True, separators=(",", ":"))
    return text


def theme_changes(previous, current):
    paths = changes(previous, current, THEME + "/")
    selected = []
    for path in paths:
        original = subprocess.run(["git", "show", f"{previous}:{path}"], capture_output=True)
        name = path[len(THEME) + 1 :]
        if (
            original.returncode == 0
            and Path(path).is_file()
            and canonical(name, original.stdout) == canonical(name, Path(path).read_bytes())
        ):
            continue
        selected.append(path)
    print(
        f"Theme deployment plan: {len(selected)} changed files; {len(paths) - len(selected)} equivalent files skipped",
        flush=True,
    )
    return selected


def replace_exact(source, old, new):
    assert old and old in source, "Bootstrap reference missing; manual review required"
    return source.replace(old, new)


def update_bootstrap(raw, meta, artifact_key, release_name):
    bundle = json.loads(raw)
    scripts = {s["name"]: s["source"] for s in bundle["scripts"]}
    assert set(scripts) == {
        "install-release.py",
        "configure-prelive-service.py",
        "configure-fleet-nginx.py",
        "configure-active-fleet.py",
    }
    install = scripts["install-release.py"]
    old_artifact = re.search(r'^expected = "([a-f0-9]{64})"$', install, re.M).group(1)
    old_key = re.search(r'^key = "([^"\n]+)"$', install, re.M).group(1)
    old_source = re.search(
        r'manifest\["sourceManifestSha256"\] == "([a-f0-9]{64})"', install
    ).group(1)
    old_name = re.search(r'target = root / \("([^"\n]+)-" \+ expected\[:12\]\)', install).group(1)
    old_bytes = re.search(r'response\["ContentLength"\] == (\d+)', install).group(1)
    old_members = re.search(r"len\(members\) == (\d+)", install).group(1)
    for entry in bundle["scripts"]:
        source = entry["source"]
        for old, new in [
            (old_key, artifact_key),
            (old_artifact, meta["sha256"]),
            (old_source, meta["sourceManifestSha256"]),
            (old_name, release_name),
            (old_artifact[:12], meta["sha256"][:12]),
        ]:
            source = source.replace(old, new)
        if entry["name"] == "install-release.py":
            source = replace_exact(
                source,
                f'response["ContentLength"] == {old_bytes}',
                f'response["ContentLength"] == {meta["bytes"]}',
            )
            source = replace_exact(
                source, f"len(members) == {old_members}", f'len(members) == {meta["members"]}'
            )
        compile(source, entry["name"], "exec")
        entry["source"] = source
    return json.dumps(bundle, separators=(",", ":")).encode(), old_source


def safe_diagnostic(raw):
    text = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else str(raw)
    text = re.sub(r"\x1b\[[0-9;]*m", "", text)
    for name, value in os.environ.items():
        if value and re.search(
            r"TOKEN|SECRET|PASSWORD|KEY|ACCOUNT_ID|STORE|THEME_ID|ASG_NAME|BUCKET|URL|ARN", name
        ):
            text = text.replace(value, "[redacted]")
    text = re.sub(
        r'https?://[^\s"<>]+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|[A-Za-z0-9_+/-]{32,}={0,2}',
        "[redacted]",
        text,
    )
    return " ".join(text.split())[:1200]


def cli(args, cwd=None):
    env = dict(os.environ)
    env.pop(
        "SHOPIFY_SERVICE_ACCOUNT_TOKEN" if args[0] == "theme" else "SHOPIFY_CLI_THEME_TOKEN", None
    )
    command = ["shopify", *args]
    if args[0] == "theme" and "--json" not in args:
        command.append("--json")
    try:
        result = subprocess.run(command, cwd=cwd, env=env, capture_output=True, timeout=300)
    except subprocess.TimeoutExpired:
        raise RuntimeError("Shopify command timed out: " + " ".join(args[:2])) from None
    if result.returncode:
        raise RuntimeError(
            "Shopify command failed: "
            + " ".join(args[:2])
            + "; "
            + safe_diagnostic(result.stdout + result.stderr)
        )
    return result.stdout


def theme_graphql(query, variables):
    request = urllib.request.Request(
        "https://theme-kit-access.shopifyapps.com/cli/admin/api/2026-10/graphql.json",
        data=json.dumps({"query": query, "variables": variables}).encode(),
        headers={
            "Content-Type": "application/json",
            "X-Shopify-Shop": os.environ["SHOPIFY_FLAG_STORE"],
            "X-Shopify-Access-Token": os.environ["SHOPIFY_CLI_THEME_TOKEN"],
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            result = json.load(response)
        if result.get("errors"):
            raise ValueError("GraphQL error")
        return result["data"]
    except Exception:
        # HTTP errors may include the signed asset URL or authentication headers.
        raise RuntimeError(
            "Shopify theme asset request failed; sensitive details suppressed"
        ) from None


def pull_theme(root, theme_args, selected=()):
    root.mkdir(parents=True, exist_ok=True)
    # A fresh local backup/readback folder is intentionally empty. This flag confirms only that.
    cli(["theme", "pull", *theme_args, "--path", str(root), "--force", *selected])


def push_theme(s3, prefix, root, names, theme_args):
    small = []
    for name in names:
        path = root / name
        if not path.exists():  # New files absent from a rollback backup stay unreferenced.
            continue
        if not name.startswith("assets/") or path.stat().st_size <= 5 * 1024 * 1024:
            small += ["--only", name]
            continue
        key = prefix + "/large-assets/" + name
        s3.upload_file(
            str(path),
            os.environ["RELEASE_BUCKET"],
            key,
            ExtraArgs={
                "ServerSideEncryption": "AES256",
                "ExpectedBucketOwner": os.environ["AWS_ACCOUNT_ID"],
                "ContentType": mimetypes.guess_type(name)[0] or "application/octet-stream",
            },
        )
        url = s3.generate_presigned_url(
            "get_object", Params={"Bucket": os.environ["RELEASE_BUCKET"], "Key": key}, ExpiresIn=300
        )
        query = "mutation ThemeAssetFromUrl($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) { themeFilesUpsert(themeId: $themeId, files: $files) { job { id } userErrors { field message } } }"
        payload = theme_graphql(
            query,
            {
                "themeId": "gid://shopify/OnlineStoreTheme/" + os.environ["SHOPIFY_THEME_ID"],
                "files": [{"filename": name, "body": {"type": "URL", "value": url}}],
            },
        )["themeFilesUpsert"]
        if payload.get("userErrors"):
            raise RuntimeError("Shopify rejected theme asset: " + name)
        job = payload.get("job")
        if job:
            deadline = time.monotonic() + 180
            while time.monotonic() < deadline:
                status = theme_graphql(
                    "query ThemeAssetJob($id: ID!) { job(id: $id) { done } }", {"id": job["id"]}
                )["job"]
                if status and status["done"]:
                    break
                time.sleep(3)
            else:
                raise RuntimeError("Shopify theme asset processing timed out: " + name)
        print("Uploaded large theme asset via expiring private download: " + name, flush=True)
    if small:
        cli(
            [
                "theme",
                "push",
                *theme_args,
                "--path",
                str(root),
                "--allow-live",
                "--nodelete",
                *small,
            ]
        )


def get_object(s3, key):
    response = s3.get_object(
        Bucket=os.environ["RELEASE_BUCKET"],
        Key=key,
        ExpectedBucketOwner=os.environ["AWS_ACCOUNT_ID"],
    )
    assert response.get("ServerSideEncryption") in ("AES256", "aws:kms")
    return response["Body"].read()


def put_object(s3, key, value):
    return s3.put_object(
        Bucket=os.environ["RELEASE_BUCKET"],
        Key=key,
        Body=value,
        ServerSideEncryption="AES256",
        ExpectedBucketOwner=os.environ["AWS_ACCOUNT_ID"],
    )


def fleet(asg):
    groups = asg.describe_auto_scaling_groups(AutoScalingGroupNames=[os.environ["ASG_NAME"]])[
        "AutoScalingGroups"
    ]
    assert len(groups) == 1
    group = groups[0]
    assert group["LaunchTemplate"]["LaunchTemplateId"] == os.environ["LAUNCH_TEMPLATE_ID"]
    assert group["LaunchTemplate"][
        "Version"
    ].isdigit(), "Pin a numeric launch-template version before CI deployment"
    return group


def wait_refresh(asg, refresh_id, seconds=2400):
    deadline = time.monotonic() + seconds
    last = None
    while time.monotonic() < deadline:
        refresh = asg.describe_instance_refreshes(
            AutoScalingGroupName=os.environ["ASG_NAME"], InstanceRefreshIds=[refresh_id]
        )["InstanceRefreshes"][0]
        status = refresh["Status"]
        progress = (status, refresh.get("PercentageComplete", 0))
        if progress != last:
            print(f"ASG refresh: {status}, {progress[1]}% complete", flush=True)
            last = progress
        if status == "Successful":
            return
        if status not in ("Pending", "InProgress", "Baking"):
            raise RuntimeError("ASG refresh did not succeed: " + status)
        time.sleep(20)
    raise RuntimeError("ASG refresh timed out")


def start_refresh(asg, version):
    group = fleet(asg)
    # Prepare both replacements together only when the existing capacity limit has room.
    max_healthy = 200 if group["MaxSize"] >= 2 * group["DesiredCapacity"] else 150
    print(
        f"Rolling replacement: minimum healthy 100%, maximum {max_healthy}%, warmup 300s",
        flush=True,
    )
    return asg.start_instance_refresh(
        AutoScalingGroupName=os.environ["ASG_NAME"],
        Strategy="Rolling",
        DesiredConfiguration={
            "LaunchTemplate": {
                "LaunchTemplateId": os.environ["LAUNCH_TEMPLATE_ID"],
                "Version": str(version),
            }
        },
        Preferences={
            "MinHealthyPercentage": 100,
            "MaxHealthyPercentage": max_healthy,
            "InstanceWarmup": 300,
            "SkipMatching": True,
            "AutoRollback": True,
        },
    )["InstanceRefreshId"]


def ssm_run(ssm, instances, commands):
    command = ssm.send_command(
        InstanceIds=instances,
        DocumentName="AWS-RunShellScript",
        Parameters={"commands": commands, "executionTimeout": ["180"]},
        TimeoutSeconds=180,
    )["Command"]["CommandId"]
    deadline = time.monotonic() + 210
    while time.monotonic() < deadline:
        result = ssm.list_command_invocations(CommandId=command)["CommandInvocations"]
        if len(result) == len(instances) and all(x["Status"] == "Success" for x in result):
            return
        if any(x["Status"] in ("Failed", "Cancelled", "TimedOut", "Cancelling") for x in result):
            raise RuntimeError("Runtime verification failed; SSM output withheld")
        time.sleep(5)
    raise RuntimeError("Runtime verification timed out")


def verify_nodes(asg, elb, ssm, version, digest):
    group = fleet(asg)
    assert group["LaunchTemplate"]["Version"] == str(version)
    nodes = group["Instances"]
    assert len(nodes) >= group["DesiredCapacity"] >= 2
    assert all(
        n["LifecycleState"] == "InService"
        and n["HealthStatus"] == "Healthy"
        and n["LaunchTemplate"]["Version"] == str(version)
        for n in nodes
    )
    instances = [n["InstanceId"] for n in nodes]
    for target_group in group["TargetGroupARNs"]:
        health = elb.describe_target_health(TargetGroupArn=target_group)["TargetHealthDescriptions"]
        healthy = {t["Target"]["Id"] for t in health if t["TargetHealth"]["State"] == "healthy"}
        assert set(instances) <= healthy, "ALB targets are not healthy"
    check = f"set -eu\ntest \"$(sed -n 's/^RELEASE_SHA=//p' /etc/purpleshoes/fleet.env)\" = '{digest}'\nsystemctl is-active --quiet purpleshoes-app nginx\ncurl --fail --silent --max-time 10 http://127.0.0.1:3000/v1/ready >/dev/null"
    ssm_run(ssm, instances, [check])
    return instances


def worker_gate(ssm, instance, prior, next_digest):
    encoded = base64.b64encode(Path("scripts/cicd/activate-worker.mjs").read_bytes()).decode()
    command = f"set -eu\numask 077\np=$(mktemp /run/ps-worker-XXXXXX.mjs)\ntrap 'rm -f \"$p\"' EXIT\nprintf '%s' '{encoded}' | base64 -d >\"$p\"\n/opt/purpleshoes/runtime/node-v22.23.3-linux-x64/bin/node \"$p\" '{prior}' '{next_digest}'"
    ssm_run(ssm, [instance], [command])


def public_health():
    with urllib.request.urlopen(os.environ["PUBLIC_HEALTH_URL"], timeout=20) as response:
        assert response.status == 200


def app_preflight():
    cli(["app", "config", "validate", "--json", "--no-input"], cwd=APP)
    versions = json.loads(cli(["app", "versions", "list", "--json", "--no-input"], cwd=APP))
    # Fail before server changes if the active app cannot be restored safely.
    rows = versions if isinstance(versions, list) else versions.get("versions", [])
    active = [v for v in rows if v.get("active") or v.get("status") == "active"]
    assert len(active) == 1, "Cannot determine active Shopify app version"
    version = active[0].get("versionTag")
    assert isinstance(version, str) and version, "The active Shopify app has no rollback tag"
    print(
        "Verified Shopify app configuration and rollback version before server changes", flush=True
    )
    return version


def deploy():
    import boto3
    from botocore.config import Config

    s3 = boto3.client("s3", config=Config(signature_version="s3v4"))
    asg, ec2, elb, ssm = [
        boto3.client(service) for service in ("autoscaling", "ec2", "elbv2", "ssm")
    ]
    assert boto3.client("sts").get_caller_identity()["Account"] == os.environ["AWS_ACCOUNT_ID"]
    state = json.loads(
        get_object(s3, STATE_KEY)
    )  # Missing baseline is a stop, never a full-store overwrite.
    sha = os.environ["GITHUB_SHA"]
    assert re.fullmatch(r"[a-f0-9]{40}", sha)
    backend_changed = changes(state["backendCommit"], sha, "apps/bta-proxy/")
    theme_changed = theme_changes(state["themeCommit"], sha)
    app_changed = changes(state["appCommit"], sha, APP + "/")
    if any(
        path.endswith("/prisma/schema.prisma") or "/prisma/migrations/" in path
        for path in backend_changed
    ):
        raise RuntimeError(
            "Database schema changes require a separately reviewed migration; automatic db push is prohibited"
        )
    if app_changed:
        require_env(["SHOPIFY_SERVICE_ACCOUNT_TOKEN"])
    if theme_changed:
        require_env(["SHOPIFY_CLI_THEME_TOKEN"])
    group = fleet(asg)
    assert not any(
        x["Status"] in ("Pending", "InProgress", "Baking", "Cancelling", "RollbackInProgress")
        for x in asg.describe_instance_refreshes(AutoScalingGroupName=os.environ["ASG_NAME"])[
            "InstanceRefreshes"
        ]
    )
    prefix = f'releases/cicd/runs/{os.environ["GITHUB_RUN_ID"]}-{os.environ.get("GITHUB_RUN_ATTEMPT", "1")}'
    put_object(s3, prefix + "/previous-state.json", json.dumps(state).encode())
    theme_args = [
        "--store",
        os.environ["SHOPIFY_FLAG_STORE"],
        "--theme",
        os.environ["SHOPIFY_THEME_ID"],
        "--no-input",
    ]
    selected = []
    for path in theme_changed:
        name = path[len(THEME) + 1 :]
        if name == "config/settings_data.json":
            raise RuntimeError("Merchant-managed theme settings must be changed separately")
        if not Path(path).is_file():
            raise RuntimeError("Theme deletion requires an explicit managed-file removal review")
        selected += ["--only", name]
    backup = OUT / "theme-backup"
    new_version = None
    prior_digest = None
    meta = None
    theme_started = False
    old_app_version = None
    app_started = False
    try:
        if app_changed:
            old_app_version = app_preflight()
        if theme_changed:
            # A rollback upload must be a valid theme directory (config, layout, templates).
            pull_theme(backup, theme_args)
            for path in theme_changed:
                name = path[len(THEME) + 1 :]
                original = subprocess.run(
                    ["git", "show", f'{state["themeCommit"]}:{path}'], capture_output=True
                )
                live = backup / name
                if original.returncode == 0:
                    if not live.exists() or canonical(name, live.read_bytes()) != canonical(
                        name, original.stdout
                    ):
                        raise RuntimeError(
                            "Live theme drift detected; deployment stopped before changes: " + name
                        )
                elif live.exists() and canonical(name, live.read_bytes()) != canonical(
                    name, Path(path).read_bytes()
                ):
                    raise RuntimeError(
                        "A new repository file conflicts with an existing live theme file: " + name
                    )
                if live.exists():
                    put_object(s3, prefix + "/theme-backup/" + name, live.read_bytes())
            print("Verified private theme backup and live-file consistency", flush=True)
        if backend_changed:
            previous = ec2.describe_launch_template_versions(
                LaunchTemplateId=os.environ["LAUNCH_TEMPLATE_ID"],
                Versions=[group["LaunchTemplate"]["Version"]],
            )["LaunchTemplateVersions"][0]["LaunchTemplateData"]
            userdata = base64.b64decode(previous["UserData"]).decode()
            key = re.search(r"Key='([^']+\.json)'", userdata).group(1)
            assert re.search(r"Bucket='([^']+)'", userdata).group(1) == os.environ["RELEASE_BUCKET"]
            expected = re.search(r"hexdigest\(\)=='([a-f0-9]{64})'", userdata).group(1)
            raw = get_object(s3, key)
            assert hashlib.sha256(raw).hexdigest() == expected
            meta = json.loads((OUT / "runtime.json").read_bytes())
            assert meta["commit"] == sha
            archive = OUT / "runtime.tgz"
            assert archive.stat().st_size == meta["bytes"]
            with archive.open("rb") as source:
                assert hashlib.file_digest(source, "sha256").hexdigest() == meta["sha256"]
            release_name = "ci-" + sha[:12] + "-" + os.environ["GITHUB_RUN_ID"]
            artifact_key = prefix + "/runtime.tgz"
            bootstrap_key = prefix + "/bootstrap.json"
            bundle, prior_digest = update_bootstrap(raw, meta, artifact_key, release_name)
            assert prior_digest == state["backendDigest"], "Runtime and deployment state disagree"
            s3.upload_file(
                str(archive),
                os.environ["RELEASE_BUCKET"],
                artifact_key,
                ExtraArgs={
                    "ServerSideEncryption": "AES256",
                    "ExpectedBucketOwner": os.environ["AWS_ACCOUNT_ID"],
                },
            )
            put_object(s3, bootstrap_key, bundle)
            userdata = replace_exact(
                replace_exact(userdata, key, bootstrap_key),
                expected,
                hashlib.sha256(bundle).hexdigest(),
            )
            # SourceVersion retains networking, instance profile, metadata protection and all other settings.
            new_version = ec2.create_launch_template_version(
                LaunchTemplateId=os.environ["LAUNCH_TEMPLATE_ID"],
                SourceVersion=group["LaunchTemplate"]["Version"],
                VersionDescription="github-" + sha[:12],
                LaunchTemplateData={"UserData": base64.b64encode(userdata.encode()).decode()},
            )["LaunchTemplateVersion"]["VersionNumber"]
            print("Uploaded verified immutable release; starting rolling replacement", flush=True)
            wait_refresh(asg, start_refresh(asg, new_version))
            instances = verify_nodes(asg, elb, ssm, new_version, meta["sourceManifestSha256"])
            worker_gate(ssm, instances[0], prior_digest, meta["sourceManifestSha256"])
            public_health()
            # Check the actual mail-worker child, not merely systemd's waiting wrapper.
            ssm_run(
                ssm,
                instances,
                [
                    "set -eu\nfor i in $(seq 1 24); do if pgrep -u purpleshoes -f '^/opt/purpleshoes/runtime/.*/bin/node --import tsx scripts/purchase-email-worker.ts --watch$' >/dev/null; then exit 0; fi; sleep 5; done\nexit 1"
                ],
            )
            print(
                "Verified replacement instances, load-balancer health and purchase workers",
                flush=True,
            )
        if app_changed:
            app_started = True
            cli(
                [
                    "app",
                    "deploy",
                    "--allow-updates",
                    "--no-input",
                    "--version",
                    "github-" + sha[:12],
                ],
                cwd=APP,
            )
            print("Verified Shopify app deployment", flush=True)
        if theme_changed:
            theme_started = True
            push_theme(
                s3,
                prefix,
                Path(THEME),
                [path[len(THEME) + 1 :] for path in theme_changed],
                theme_args,
            )
            verify = OUT / "theme-verify"
            pull_theme(verify, theme_args, selected)
            for path in theme_changed:
                name = path[len(THEME) + 1 :]
                remote = verify / name
                if not remote.exists() or canonical(name, Path(path).read_bytes()) != canonical(
                    name, remote.read_bytes()
                ):
                    raise RuntimeError("Shopify readback mismatch: " + name)
            print("Verified Shopify live-file readback", flush=True)
        public_health()
        next_state = {
            **state,
            "backendCommit": sha,
            "themeCommit": sha,
            "appCommit": sha,
            "backendDigest": meta["sourceManifestSha256"] if meta else state["backendDigest"],
            "runId": os.environ["GITHUB_RUN_ID"],
        }
        put_object(s3, STATE_KEY, json.dumps(next_state).encode())
        (OUT / "summary.md").write_text(
            f"Commit `{sha}` verified and deployed.\n\nBackend: {bool(backend_changed)}; theme files: {len(theme_changed)}; app: {bool(app_changed)}.\n",
            encoding="utf-8",
        )
    except Exception as error:
        reason = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        print(
            "Deployment stopped; restoring prior state. Reason: " + safe_diagnostic(reason),
            flush=True,
        )
        rollback_errors = []
        if theme_started:
            try:
                # Restore prior referenced files; newly uploaded, unreferenced assets remain for inspection.
                push_theme(
                    s3,
                    prefix + "/restore",
                    backup,
                    [path[len(THEME) + 1 :] for path in theme_changed],
                    theme_args,
                )
                restored = OUT / "theme-restored"
                pull_theme(restored, theme_args, selected)
                for path in theme_changed:
                    name = path[len(THEME) + 1 :]
                    if (backup / name).exists() and (
                        not (restored / name).exists()
                        or canonical(name, (backup / name).read_bytes())
                        != canonical(name, (restored / name).read_bytes())
                    ):
                        raise RuntimeError("Shopify restored-file readback mismatch: " + name)
            except Exception:
                rollback_errors.append("Shopify theme restore requires attention")
        if app_started and old_app_version:
            try:
                cli(
                    [
                        "app",
                        "release",
                        "--allow-updates",
                        "--no-input",
                        "--version",
                        old_app_version,
                    ],
                    cwd=APP,
                )
            except Exception:
                rollback_errors.append("Shopify app restore requires attention")
        if new_version:
            try:
                # A completed refresh cannot be rolled back via RollbackInstanceRefresh; refresh to the previous numeric version.
                active = asg.describe_instance_refreshes(
                    AutoScalingGroupName=os.environ["ASG_NAME"]
                )["InstanceRefreshes"]
                if active and active[0]["Status"] in ("Pending", "InProgress", "Baking"):
                    asg.cancel_instance_refresh(
                        AutoScalingGroupName=os.environ["ASG_NAME"],
                        WaitForTransitioningInstances=True,
                    )
                    deadline = time.monotonic() + 600
                    while time.monotonic() < deadline:
                        status = asg.describe_instance_refreshes(
                            AutoScalingGroupName=os.environ["ASG_NAME"]
                        )["InstanceRefreshes"][0]["Status"]
                        if status not in ("Pending", "InProgress", "Baking", "Cancelling"):
                            break
                        time.sleep(10)
                if active and active[0]["Status"] == "RollbackInProgress":
                    deadline = time.monotonic() + 1800
                    while time.monotonic() < deadline:
                        status = asg.describe_instance_refreshes(
                            AutoScalingGroupName=os.environ["ASG_NAME"]
                        )["InstanceRefreshes"][0]["Status"]
                        if status != "RollbackInProgress":
                            break
                        time.sleep(20)
                wait_refresh(
                    asg, start_refresh(asg, group["LaunchTemplate"]["Version"]), seconds=1800
                )
                old_nodes = verify_nodes(
                    asg, elb, ssm, group["LaunchTemplate"]["Version"], state["backendDigest"]
                )
                # Also restore after an uncertain SSM result: the SQL update may already have committed.
                worker_gate(ssm, old_nodes[0], meta["sourceManifestSha256"], prior_digest)
            except Exception:
                rollback_errors.append("AWS previous-release restore requires attention")
        (OUT / "summary.md").write_text(
            "Deployment failed. Prior deployment state retained.\n\nReason: "
            + reason
            + "\n\n"
            + "\n".join(rollback_errors)
            + "\n",
            encoding="utf-8",
        )
        raise RuntimeError(
            reason
            + "; "
            + (
                "; ".join(rollback_errors)
                if rollback_errors
                else "prior referenced files and runtime restored"
            )
        ) from None


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    try:
        require_env(
            [
                "AWS_REGION",
                "AWS_ACCOUNT_ID",
                "RELEASE_BUCKET",
                "ASG_NAME",
                "LAUNCH_TEMPLATE_ID",
                "SHOPIFY_FLAG_STORE",
                "SHOPIFY_THEME_ID",
                "PUBLIC_HEALTH_URL",
            ]
        )
        assert re.fullmatch(r"\d{12}", os.environ["AWS_ACCOUNT_ID"])
        assert re.fullmatch(r"lt-[a-f0-9]+", os.environ["LAUNCH_TEMPLATE_ID"])
        assert re.fullmatch(r"[a-z0-9-]+\.myshopify\.com", os.environ["SHOPIFY_FLAG_STORE"])
        assert os.environ["PUBLIC_HEALTH_URL"].startswith("https://")
        if sys.argv[1] == "preflight":
            require_env(["AWS_DEPLOY_ROLE_ARN"])
            print("Required deployment configuration is present. Values suppressed.")
        elif sys.argv[1] == "deploy":
            deploy()
        else:
            raise RuntimeError("Unknown deployment operation")
    except Exception as error:
        # Do not print SDK/HTTP exception bodies or raw bootstrap documents to a public workflow log.
        safe = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        print("::error::" + safe.replace("\n", " "))
        sys.exit(1)
