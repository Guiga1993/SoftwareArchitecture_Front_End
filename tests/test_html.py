"""Static contract tests for the frontend HTML document."""

from pathlib import Path

import pytest
from bs4 import BeautifulSoup


# Resolve project files from this test location so tests work from any current directory.
PROJECT_ROOT = Path(__file__).resolve().parents[1]
HTML_PATH = PROJECT_ROOT / "index.html"

# These IDs are shared with scripts.js and form the application's navigation contract.
EXPECTED_FORMS = {
    "customerForm",
    "generatorForm",
    "customerGeneratorForm",
    "shippingQuoteForm",
}
EXPECTED_PANELS = {
    "customer-section",
    "generator-section",
    "customer-generators-section",
    "shipping-section",
}


# Parse the document once because every test reads the same static HTML file.
@pytest.fixture(scope="module")
def document():
    return BeautifulSoup(HTML_PATH.read_text(encoding="utf-8"), "html.parser")


# Document shell and resource references
def test_document_has_required_metadata_and_assets(document):
    assert document.html.get("lang") == "en"
    assert document.title.string.strip() == "Hydrogen Generator Management"
    assert document.select_one('meta[charset="UTF-8"]') is not None
    assert document.select_one('meta[name="viewport"]') is not None
    assert document.select_one('link[rel="stylesheet"][href="style.css"]') is not None
    assert document.select_one('script[src="scripts.js"]') is not None


def test_all_ids_are_unique(document):
    ids = [element["id"] for element in document.select("[id]")]
    duplicates = sorted({element_id for element_id in ids if ids.count(element_id) > 1})

    assert duplicates == []


# Accessibility relationships between labels, tabs, and controlled panels
def test_every_label_targets_an_existing_control(document):
    ids = {element["id"] for element in document.select("[id]")}
    broken_targets = [
        label.get("for")
        for label in document.find_all("label")
        if not label.get("for") or label.get("for") not in ids
    ]

    assert broken_targets == []


def test_tabs_and_panels_have_reciprocal_aria_links(document):
    tabs = {tab["id"]: tab for tab in document.select('[role="tab"]')}
    panels = {panel["id"]: panel for panel in document.select('[role="tabpanel"]')}

    assert set(panels) == EXPECTED_PANELS
    assert len(tabs) == len(EXPECTED_PANELS)
    for tab_id, tab in tabs.items():
        panel_id = tab.get("aria-controls")
        assert panel_id in panels
        assert tab.get("data-tab-target") == panel_id
        assert panels[panel_id].get("aria-labelledby") == tab_id


    # Form semantics and native browser-validation contracts
def test_action_forms_have_one_submit_button(document):
    forms = {form["id"]: form for form in document.find_all("form")}

    assert set(forms) == EXPECTED_FORMS
    for form in forms.values():
        assert len(form.select('button[type="submit"]')) == 1


def test_management_forms_have_edit_mode_controls(document):
    expected_controls = {
        "customerForm": ("customerSubmitButton", "cancelCustomerEdit"),
        "generatorForm": ("generatorSubmitButton", "cancelGeneratorEdit"),
        "customerGeneratorForm": ("assetSubmitButton", "cancelAssetEdit"),
    }

    for form_id, (submit_id, cancel_id) in expected_controls.items():
        form = document.find(id=form_id)
        assert form.find(id=submit_id, attrs={"type": "submit"}) is not None
        cancel = form.find(id=cancel_id, attrs={"type": "button"})
        assert cancel is not None
        assert cancel.has_attr("hidden")


def test_management_tables_label_action_columns(document):
    for table_id in ("customerTable", "generatorTable", "customerGeneratorTable"):
        table = document.find(id=table_id)
        assert table.select_one("thead th.action-column").get_text(strip=True) == "Actions"


def test_all_form_controls_have_names(document):
    unnamed_controls = [
        control.get("id")
        for control in document.select("input, select, textarea")
        if not control.get("name")
    ]

    assert unnamed_controls == []


@pytest.mark.parametrize(
    "control_id",
    [
        "custName",
        "custEmail",
        "custTaxId",
        "newSerial",
        "newAcquisition",
        "newGenType",
        "newCells",
        "newVoltage",
        "newCurrent",
        "newLength",
        "newWidth",
        "newHeight",
        "newWeight",
        "cgCustomerId",
        "cgGeneratorId",
        "cgGeneratorQtd",
        "originName",
        "originStreet",
        "originCity",
        "originState",
        "originZip",
        "shipCustomerName",
        "destinationStreet",
        "destinationCity",
        "destinationState",
        "destinationZip",
        "shippingGeneratorId",
        "shippingQuantity",
    ],
)
def test_required_controls_are_marked_required(document, control_id):
    control = document.find(id=control_id)

    assert control is not None
    assert control.has_attr("required")


def test_installation_date_remains_optional(document):
    assert not document.find(id="cgInstallationDate").has_attr("required")


# Local assets must remain available when the application is used offline.
def test_images_are_local_and_have_alt_attributes(document):
    for image in document.find_all("img"):
        source = image.get("src", "")
        assert not source.startswith(("http://", "https://"))
        assert (PROJECT_ROOT / source).is_file()
        assert image.has_attr("alt")


def test_stylesheet_and_script_files_exist(document):
    references = [
        element[attribute]
        for selector, attribute in (("link[href]", "href"), ("script[src]", "src"))
        for element in document.select(selector)
    ]

    assert all((PROJECT_ROOT / reference).is_file() for reference in references)


# Dynamic quote output uses one accessible surface rather than nested cards.
def test_shipping_result_is_flat_and_announced(document):
    result = document.find(id="shippingResult")

    assert result is not None
    assert "shipping-result" in result.get("class", [])
    assert "container" not in result.get("class", [])
    assert result.get("aria-live") == "polite"


def test_shipping_form_keeps_measurements_read_only(document):
    """Prevent callers from submitting generator dimensions or weight."""
    form = document.find(id="shippingQuoteForm")
    for control_id in (
        "shippingUnitDimensions",
        "shippingUnitWeight",
        "shippingCombinedShipment",
    ):
        assert form.find(id=control_id).has_attr("readonly")


def test_no_remote_flaticon_dependencies_remain(document):
    assert "flaticon.com" not in str(document)