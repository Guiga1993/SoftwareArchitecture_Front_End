"""Static syntax and integration-contract tests for scripts.js."""

import re
from pathlib import Path

import esprima
import pytest
from bs4 import BeautifulSoup


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = PROJECT_ROOT / "scripts.js"
HTML_PATH = PROJECT_ROOT / "index.html"

EXPECTED_SECTIONS = [
    "Configuration and Shared State",
    "Shared Utilities",
    "Navigation and Shipping Display",
    "Search Workflows",
    "API Client",
    "Table Rendering",
    "Customer Form Workflow",
    "Generator Form Workflow",
    "Relationship Form Workflow",
    "Shipping Quote Workflow",
    "Application Initialization",
]

EXPECTED_API_PATHS = {
    "/customers",
    "/customer",
    "/hydrogen-generators",
    "/hydrogen-generator",
    "/assets",
    "/asset",
    "/shipping-quote",
}

EXPECTED_SHIPPING_FIELDS = {
    "origin_name",
    "origin_street",
    "origin_city",
    "origin_state",
    "origin_zip",
    "customer_name",
    "destination_street",
    "destination_city",
    "destination_state",
    "destination_zip",
    "generator_id",
    "generator_quantity",
}


@pytest.fixture(scope="module")
def source():
    return SCRIPT_PATH.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def syntax_tree(source):
    # Parsing the complete file makes unsupported or malformed JavaScript fail the suite.
    return esprima.parseScript(source, loc=True).toDict()


@pytest.fixture(scope="module")
def document():
    return BeautifulSoup(HTML_PATH.read_text(encoding="utf-8"), "html.parser")


def get_top_level_declarations(syntax_tree):
    declarations = []
    for statement in syntax_tree["body"]:
        if statement["type"] == "FunctionDeclaration":
            declarations.append(statement["id"]["name"])
        elif statement["type"] == "VariableDeclaration":
            declarations.extend(
                declaration["id"]["name"]
                for declaration in statement["declarations"]
                if declaration["id"]["type"] == "Identifier"
            )
    return declarations


def get_declaration_source(source, syntax_tree, name):
    lines = source.splitlines()
    for statement in syntax_tree["body"]:
        declared_names = []
        if statement["type"] == "FunctionDeclaration":
            declared_names.append(statement["id"]["name"])
        elif statement["type"] == "VariableDeclaration":
            declared_names.extend(
                declaration["id"]["name"]
                for declaration in statement["declarations"]
                if declaration["id"]["type"] == "Identifier"
            )
        if name in declared_names:
            start = statement["loc"]["start"]["line"] - 1
            end = statement["loc"]["end"]["line"]
            return "\n".join(lines[start:end])
    raise AssertionError(f"Top-level declaration not found: {name}")


def test_javascript_has_valid_syntax(syntax_tree):
    assert syntax_tree["type"] == "Program"
    assert syntax_tree["sourceType"] == "script"


def test_top_level_declarations_are_unique(syntax_tree):
    declarations = get_top_level_declarations(syntax_tree)
    duplicates = sorted({name for name in declarations if declarations.count(name) > 1})

    assert duplicates == []


def test_top_level_callable_declarations_have_jsdoc(source, syntax_tree):
    """Keep purpose and contracts adjacent to every production callable."""
    callable_types = {"FunctionDeclaration", "ArrowFunctionExpression"}
    lines = source.splitlines()
    undocumented = []

    for statement in syntax_tree["body"]:
        declaration_name = None
        is_callable = statement["type"] == "FunctionDeclaration"
        if is_callable:
            declaration_name = statement["id"]["name"]
        elif statement["type"] == "VariableDeclaration":
            declaration = statement["declarations"][0]
            initializer = declaration.get("init") or {}
            is_callable = initializer.get("type") in callable_types
            if is_callable:
                declaration_name = declaration["id"]["name"]

        if not is_callable:
            continue

        declaration_line = statement["loc"]["start"]["line"] - 1
        preceding_source = "\n".join(lines[:declaration_line]).rstrip()
        if not preceding_source.endswith("*/"):
            undocumented.append(declaration_name)

    assert undocumented == []


def test_sections_follow_the_documented_order(source):
    positions = [source.index(section) for section in EXPECTED_SECTIONS]

    assert positions == sorted(positions)


def test_configuration_constants_match_frontend_contract(source):
    assert "window.location.port === '5500'" in source
    assert "? 'http://127.0.0.1:5001'" in source
    assert ": '/api';" in source
    assert "const MAX_PARCEL_SIDE_IN = 108;" in source
    assert "const MAX_PARCEL_LENGTH_PLUS_GIRTH_IN = 165;" in source
    assert "const MAX_PARCEL_WEIGHT_LB = 150;" in source


def test_javascript_dom_ids_exist_in_html(source, document):
    html_ids = {element["id"] for element in document.select("[id]")}
    referenced_ids = set(
        re.findall(r"getElementById\(\s*['\"]([^'\"]+)['\"]\s*\)", source)
    )

    assert sorted(referenced_ids - html_ids) == []


def test_inline_html_handlers_have_javascript_declarations(document, syntax_tree):
    declarations = set(get_top_level_declarations(syntax_tree))
    handlers = {
        match.group(1)
        for element in document.select("[onclick]")
        if (match := re.match(r"\s*([A-Za-z_$][\w$]*)\s*\(", element["onclick"]))
    }

    assert sorted(handlers - declarations) == []


def test_expected_api_routes_are_referenced(source):
    referenced_paths = set(re.findall(r"apiUrl\(\s*[`'\"](/[-a-z]+)", source))

    assert referenced_paths == EXPECTED_API_PATHS


def test_runtime_javascript_does_not_expose_internal_services(source):
    assert "backend:5001" not in source
    assert "shippo-integration" not in source
    assert "api.goshippo.com" not in source
    assert "127.0.0.1:8001" not in source


def test_form_submit_handlers_are_registered_once(source):
    for form_id in (
        "customerForm",
        "generatorForm",
        "customerGeneratorForm",
        "shippingQuoteForm",
    ):
        pattern = rf"getElementById\('{form_id}'\)\.addEventListener\('submit'"
        assert len(re.findall(pattern, source)) == 1


def test_initialization_occurs_after_workflow_declarations(source):
    initialization_position = source.index("// Application Initialization")

    for declaration in ("newCustomer", "newGenerator", "newCustomerGenerator", "calculateShippingQuote"):
        assert source.index(f"const {declaration}") < initialization_position


def test_shipping_payload_contains_all_api_fields(source, syntax_tree):
    quote_source = get_declaration_source(source, syntax_tree, "calculateShippingQuote")
    payload_fields = set(re.findall(r"^\s+([a-z_]+):", quote_source, re.MULTILINE))

    assert EXPECTED_SHIPPING_FIELDS <= payload_fields


def test_shipping_request_normalizes_business_fields(source, syntax_tree):
    """Require trimmed addresses, numeric selection, and explicit format guards."""
    quote_source = get_declaration_source(source, syntax_tree, "calculateShippingQuote")

    assert quote_source.count(".value.trim()") >= 10
    assert ".value.trim().toUpperCase()" in quote_source
    assert "const generatorId = Number(" in quote_source
    assert "const generatorQuantity = Number(" in quote_source
    assert "addressFields.some(value => !value)" in quote_source
    assert "const statePattern = /^[A-Z]{2}$/;" in quote_source
    assert "const zipPattern = /^\\d{5}(?:-\\d{4})?$/;" in quote_source


def test_shipping_messages_use_stable_object_shape(source, syntax_tree):
    """Render normalized provider messages safely when the field is absent."""
    quote_source = get_declaration_source(source, syntax_tree, "calculateShippingQuote")

    assert "const messages = data.shippo_messages || [];" in quote_source
    assert "msg.source || 'Shippo'" in quote_source
    assert "msg.message || ''" in quote_source


def test_parcel_formula_uses_all_three_dimensions(source, syntax_tree):
    function_source = get_declaration_source(
        source,
        syntax_tree,
        "getParcelLengthPlusGirth",
    )

    assert "generator.length_in" in function_source
    assert "generator.width_in" in function_source
    assert "generator.height_in" in function_source
    assert "dimensions[0] + 2 * (dimensions[1] + dimensions[2])" in function_source


def test_serial_number_is_url_encoded(source, syntax_tree):
    function_source = get_declaration_source(source, syntax_tree, "getGeneratorBySerial")

    assert "encodeURIComponent(serialNumber)" in function_source


def test_put_clients_target_all_editable_resources(source, syntax_tree):
    expected_clients = {
        "putCustomer": "/customer?customer_id=",
        "putGenerator": "/hydrogen-generator?serial_number=",
        "putAsset": "/asset?asset_id=",
    }

    for client_name, route in expected_clients.items():
        function_source = get_declaration_source(source, syntax_tree, client_name)
        assert route in function_source
        assert "method: 'put'" in function_source


def test_generator_put_url_encodes_current_serial(source, syntax_tree):
    function_source = get_declaration_source(source, syntax_tree, "putGenerator")

    assert "encodeURIComponent(currentSerial)" in function_source


def test_row_actions_include_accessible_edit_and_delete_buttons(source, syntax_tree):
    function_source = get_declaration_source(source, syntax_tree, "appendRowActions")

    assert "Edit ${resourceName}" in function_source
    assert "Delete ${resourceName}" in function_source
    assert "createIconButton" in function_source


def test_client_code_contains_no_shippo_credentials(source):
    assert "SHIPPO_API_KEY" not in source
    assert "ShippoToken" not in source
    assert "shippo_test_" not in source
    assert "shippo_live_" not in source
    assert "SHIPPO_INTEGRATION_BASE_URL" not in source
    assert "127.0.0.1:8001" not in source