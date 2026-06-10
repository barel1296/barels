from gros_workers.triage import PLAYBOOK_FOR_METRIC, playbook_for


def test_metric_routing_covers_core_playbooks() -> None:
    assert playbook_for("roas_d7", "down") == "roas_drop"
    assert playbook_for("cpi", "up") == "cpi_spike"
    assert playbook_for("creative_ipm", "down") == "creative_fatigue"


def test_unknown_metric_falls_back_to_roas_drop() -> None:
    assert playbook_for("some_new_metric", "down") == "roas_drop"


def test_routing_table_targets_only_seeded_playbooks() -> None:
    assert set(PLAYBOOK_FOR_METRIC.values()) <= {
        "roas_drop", "cpi_spike", "creative_fatigue", "tracking_break",
    }
