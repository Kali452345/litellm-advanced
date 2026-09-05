import pytest

from litellm.router_utils.quota.scope import QuotaScope, resolve_quota_scope
from litellm.types.router import QuotaScopeMode

API_KEY = "sk-quota-test-abcdef123456"
OTHER_API_KEY = "sk-quota-test-fedcba654321"


def scope_for(
    *,
    mode: QuotaScopeMode = "credential_model",
    litellm_model: str | None = "gemini/gemini-2.5-flash",
    deployment_id: str = "deployment-1",
    quota_scope_id: str | None = None,
    litellm_credential_name: str | None = None,
    api_base: str | None = None,
    api_key: str | None = None,
) -> QuotaScope:
    return resolve_quota_scope(
        mode=mode,
        litellm_model=litellm_model,
        deployment_id=deployment_id,
        quota_scope_id=quota_scope_id,
        litellm_credential_name=litellm_credential_name,
        api_base=api_base,
        api_key=api_key,
    )


def test_explicit_scope_id_wins_over_everything_else():
    scope = scope_for(
        quota_scope_id="team-shared-key",
        litellm_credential_name="stored-cred",
        api_key=API_KEY,
    )

    assert scope.scope_id == "id:team-shared-key"


def test_stored_credential_name_wins_over_the_key_digest():
    scope = scope_for(litellm_credential_name="stored-cred", api_key=API_KEY)

    assert scope.scope_id == "cred:stored-cred"


def test_key_digest_is_used_when_there_is_no_named_credential():
    scope = scope_for(api_key=API_KEY, api_base="https://example.invalid/v1")

    assert scope.scope_id.startswith("key:")


def test_credential_less_deployments_stay_separate_instead_of_merging():
    first = scope_for(deployment_id="deployment-1")
    second = scope_for(deployment_id="deployment-2")

    assert first.scope_id == "deployment:deployment-1"
    assert second.scope_id != first.scope_id


def test_one_key_serving_many_models_shares_the_credential_but_splits_the_counter():
    flash = scope_for(litellm_model="gemini/gemini-2.5-flash", api_key=API_KEY, deployment_id="a")
    pro = scope_for(litellm_model="gemini/gemini-2.5-pro", api_key=API_KEY, deployment_id="b")

    assert flash.scope_id == pro.scope_id
    assert flash.key_prefix != pro.key_prefix


def test_credential_mode_collapses_every_model_onto_one_counter():
    flash = scope_for(mode="credential", litellm_model="gemini/gemini-2.5-flash", api_key=API_KEY, deployment_id="a")
    pro = scope_for(mode="credential", litellm_model="gemini/gemini-2.5-pro", api_key=API_KEY, deployment_id="b")

    assert flash.model is None
    assert flash.key_prefix == pro.key_prefix


def test_two_deployments_that_differ_only_by_deployment_id_share_the_key_scope():
    first = scope_for(api_key=API_KEY, deployment_id="deployment-1")
    second = scope_for(api_key=API_KEY, deployment_id="deployment-2")

    assert first.key_prefix == second.key_prefix


def test_different_keys_and_different_bases_get_different_scopes():
    base_case = scope_for(api_key=API_KEY, api_base="https://example.invalid/v1")
    other_key = scope_for(api_key=OTHER_API_KEY, api_base="https://example.invalid/v1")
    other_base = scope_for(api_key=API_KEY, api_base="https://other.invalid/v1")

    assert len({base_case.scope_id, other_key.scope_id, other_base.scope_id}) == 3


@pytest.mark.parametrize("field", ["scope_id", "key_prefix"])
def test_the_api_key_never_appears_in_the_derived_scope(field: str):
    scope = scope_for(api_key=API_KEY, api_base="https://example.invalid/v1")
    rendered = getattr(scope, field)

    assert API_KEY not in rendered
    for length in (8, 12, 16):
        assert API_KEY[-length:] not in rendered


def test_the_digest_is_keyed_by_the_salt_so_it_cannot_be_recomputed_from_the_key_alone(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("LITELLM_SALT_KEY", "salt-one")
    with_first_salt = scope_for(api_key=API_KEY).scope_id

    monkeypatch.setenv("LITELLM_SALT_KEY", "salt-two")
    with_second_salt = scope_for(api_key=API_KEY).scope_id

    assert with_first_salt != with_second_salt


def test_key_prefix_is_a_single_redis_cluster_hash_tag():
    prefix = scope_for(api_key=API_KEY).key_prefix

    assert prefix.startswith("{")
    assert prefix.endswith("}")
    assert prefix.count("{") == 1
    assert prefix.count("}") == 1
