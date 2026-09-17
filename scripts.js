/*
 * Browser controller for CRUD workflows, table rendering, and shipping quotes.
 * The application intentionally uses no framework: top-level declarations are
 * grouped by dependency, and DOM event registration remains in the final block.
 *
 * File organization:
 * 1. Configuration and shared state
 * 2. Shared utilities
 * 3. Navigation and shipping display
 * 4. Search workflows
 * 5. API client
 * 6. Table rendering
 * 7. Form workflows by domain
 * 8. Application initialization
 */

// =============================================================================
// Configuration and Shared State
// =============================================================================

const API_BASE = 'http://127.0.0.1:5001';
const MAX_PARCEL_SIDE_IN = 108;
const MAX_PARCEL_LENGTH_PLUS_GIRTH_IN = 165;
const MAX_PARCEL_WEIGHT_LB = 150;

// Shared cache drives both the generator table and shipping selector.
let availableGenerators = [];
// Each value stores the immutable lookup key used by PUT while form fields edit.
const editState = {
  customerId: null,
  generatorSerial: null,
  assetId: null,
};


// =============================================================================
// Shared Utilities
// =============================================================================

/** Remove rendered records without deleting backend data. */
function clearTableRows(tableId) {
  const table = document.getElementById(tableId);
  if (table && table.tBodies && table.tBodies[0]) {
    table.tBodies[0].innerHTML = '';
  }
}

// Normalize the response shapes produced by route errors and OpenAPI validation.
/**
 * Normalize Flask and flask-openapi3 error payloads for user-facing alerts.
 * @param {object} data Parsed response payload.
 * @param {string} fallback Message used when no structured error is available.
 * @returns {string} A displayable error message.
 */
const extractErrorMessage = (data, fallback) => {
  // If the response has a 'message' property, return it
  if (data.message) return data.message;
  // If 'detail' is an array, join all messages
  if (Array.isArray(data.detail)) {
    return data.detail.map(e => e.msg || JSON.stringify(e)).join('\n');
  }
  // If 'detail' is a string, return it
  if (typeof data.detail === 'string') return data.detail;
  // If 'validation_error' exists, extract all error messages from possible locations
  if (data.validation_error) {
    const validation = data.validation_error; // Get the validation_error object
    const items = [
      ...(Array.isArray(validation.body) ? validation.body : []), // Errors in body
      ...(Array.isArray(validation.form) ? validation.form : []), // Errors in form
      ...(Array.isArray(validation.body_params) ? validation.body_params : []), // Errors in body_params
      ...(Array.isArray(validation.query) ? validation.query : []), // Errors in query
      ...(Array.isArray(validation.path) ? validation.path : []), // Errors in path
    ];
    // If there are any error items, join their messages
    if (items.length) {
      return items.map(e => e.msg || JSON.stringify(e)).join('\n');
    }
  }
  // If nothing found, return the fallback message
  return fallback;
}

// Preserve structured validation details so form workflows can highlight fields.
/** Return structured validation entries so workflows can mark specific fields. */
const extractRawDetail = (data) => {
  // If 'detail' is an array, return it directly (common error format)
  if (Array.isArray(data.detail)) return data.detail;
  // If 'validation_error' exists, collect all possible error arrays
  if (data.validation_error) {
    const validation = data.validation_error; // Get the validation_error object
    const items = [
      ...(Array.isArray(validation.body) ? validation.body : []), // Errors in body
      ...(Array.isArray(validation.form) ? validation.form : []), // Errors in form
      ...(Array.isArray(validation.body_params) ? validation.body_params : []), // Errors in body_params
      ...(Array.isArray(validation.query) ? validation.query : []), // Errors in query
      ...(Array.isArray(validation.path) ? validation.path : []), // Errors in path
    ];
    // If there are any error items, return them
    if (items.length) return items;
  }
  // If no errors found, return null
  return null;
}

/** Clear validation styling and messages for the supplied control IDs. */
const clearFieldErrors = (fieldIds) => {
  fieldIds.forEach(id => {
    const element = document.getElementById(id);
    element.classList.remove('input-error');
    const message = element.parentElement.querySelector('.error-message');
    if (message) message.remove();
  });
};

/** Mark one form control invalid and append its validation message. */
const markFieldError = (id, message) => {
  const element = document.getElementById(id);
  element.classList.add('input-error');

  const errorMessage = document.createElement('span');
  errorMessage.className = 'error-message';
  errorMessage.textContent = message;
  element.parentElement.appendChild(errorMessage);
};


// =============================================================================
// Navigation and Shipping Display
// =============================================================================

/** Initialize accessible tab selection, keyboard navigation, and panel visibility. */
function initializeTabs() {
  const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
  const panels = Array.from(document.querySelectorAll('[role="tabpanel"]'));

  // Keep selection, visibility, and roving keyboard focus synchronized.
  const activateTab = (selectedTab, moveFocus = false) => {
    tabs.forEach(tab => {
      const isSelected = tab === selectedTab;
      tab.classList.toggle('active', isSelected);
      tab.setAttribute('aria-selected', String(isSelected));
      tab.tabIndex = isSelected ? 0 : -1;
    });

    panels.forEach(panel => {
      panel.hidden = panel.id !== selectedTab.dataset.tabTarget;
    });

    if (moveFocus) selectedTab.focus();
  };

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => activateTab(tab));
    tab.addEventListener('keydown', event => {
      let nextIndex = index;

      if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = tabs.length - 1;
      else return;

      event.preventDefault();
      activateTab(tabs[nextIndex], true);
    });
  });
}

/** Rebuild the shipping generator selector while preserving a valid selection. */
function refreshShippingGeneratorOptions() {
  const select = document.getElementById('shippingGeneratorId');
  // Preserve the current selection when generator data is reloaded.
  const selectedId = select.value;
  select.innerHTML = '<option value="" disabled>Select a generator...</option>';

  availableGenerators.forEach(generator => {
    const option = document.createElement('option');
    option.value = generator.generator_id;
    option.textContent = `#${generator.generator_id} - ${generator.serial_number}`;
    select.appendChild(option);
  });

  if (availableGenerators.some(generator => String(generator.generator_id) === selectedId)) {
    select.value = selectedId;
  } else {
    select.selectedIndex = 0;
  }

  updateShippingMeasurements();
}

/**
 * Calculate the carrier parcel metric using the longest side as length.
 * @param {object} generator Generator measurements in inches.
 * @returns {number} Length plus girth in inches.
 */
function getParcelLengthPlusGirth(generator) {
  // Carrier limits use the longest side plus twice the sum of the other sides.
  const dimensions = [generator.length_in, generator.width_in, generator.height_in]
    .sort((first, second) => second - first);
  return dimensions[0] + 2 * (dimensions[1] + dimensions[2]);
}

/** Synchronize read-only shipping measurements with generator and quantity inputs. */
function updateShippingMeasurements() {
  const generatorId = Number(document.getElementById('shippingGeneratorId').value);
  const quantity = Number(document.getElementById('shippingQuantity').value);
  const generator = availableGenerators.find(item => item.generator_id === generatorId);
  const unitDimensions = document.getElementById('shippingUnitDimensions');
  const unitWeight = document.getElementById('shippingUnitWeight');
  const combinedShipment = document.getElementById('shippingCombinedShipment');

  if (!generator) {
    unitDimensions.value = '';
    unitWeight.value = '';
    combinedShipment.value = '';
    return;
  }

  unitDimensions.value = `${generator.length_in} × ${generator.width_in} × ${generator.height_in} in`;
  unitWeight.value = `${generator.weight_lb} lb`;

  if (Number.isInteger(quantity) && quantity > 0) {
    const parcelLabel = quantity === 1 ? 'parcel' : 'parcels';
    const lengthPlusGirth = getParcelLengthPlusGirth(generator);
    const requiresFreight = lengthPlusGirth > MAX_PARCEL_LENGTH_PLUS_GIRTH_IN;
    // Each generator remains an individual parcel; quantity changes only total weight.
    combinedShipment.value = requiresFreight
      ? `Freight required: ${lengthPlusGirth} in length + girth exceeds ${MAX_PARCEL_LENGTH_PLUS_GIRTH_IN} in parcel limit`
      : `${quantity} ${parcelLabel}, ${generator.length_in} × ${generator.width_in} × ${generator.height_in} in each, ${generator.weight_lb * quantity} lb total`;
  } else {
    combinedShipment.value = '';
  }
}


// =============================================================================
// Search Workflows
// =============================================================================

/** Validate the customer search input and render the matching record. */
function searchCustomerRecord() {
  // Get the input element for customer ID
  const idInput = document.getElementById('searchCustomerId');
  // Parse the input value as an integer, or null if not present
  const customerId = idInput && idInput.value ? parseInt(idInput.value, 10) : null;
  // Clear the customer table before displaying results
  clearTableRows('customerTable');
  // If the ID is invalid, show an alert and stop
  if (!customerId || customerId <= 0) {
    alert('Enter a valid customer ID to search.');
    return;
  }
  // Fetch the customer by ID from the backend
  getCustomerById(customerId).then(data => {
    // If a customer is found, insert it into the table
    if (data && data.customer_id) {
      insertCustomer(data.customer_id, data.name, data.email, data.tx_id);
    } else {
      // If not found, show an alert
      alert('Customer not found.');
    }
  }).catch(() => {
    // If an error occurs, show an alert
    alert('Error searching for the customer.');
  });
}

/** Normalize a generator serial search and render the matching record. */
function searchGeneratorRecord() {
  // Get the input element for generator serial number
  const serialInput = document.getElementById('searchGeneratorSerial');
  // Get the serial value, trim and convert to uppercase
  const serial = serialInput && serialInput.value ? serialInput.value.trim().toUpperCase() : null;
  // Clear the generator table before displaying results
  clearTableRows('generatorTable');
  // If the serial is invalid, show an alert and stop
  if (!serial) {
    alert('Enter a valid serial number to search.');
    return;
  }
  // Fetch the generator by serial from the backend
  getGeneratorBySerial(serial).then(data => {
    // If a generator is found, insert it into the table
    if (data && data.generator_id) {
      insertGenerator(
        data.generator_id,
        data.serial_number,
        data.acquisition_type,
        data.stack_type,
        data.number_of_cells,
        data.stack_voltage,
        data.current_density,
        (data.stack_voltage / data.number_of_cells).toFixed(2),
        data.length_in,
        data.width_in,
        data.height_in,
        data.weight_lb
      );
    } else {
      // If not found, show an alert
      alert('Generator not found.');
    }
  }).catch(() => {
    // If an error occurs, show an alert
    alert('Error searching for the generator.');
  });
}

/** Validate the relationship search input and render the matching record. */
function searchAssetRecord() {
  // Get the input element for asset ID
  const assetInput = document.getElementById('searchAssetId');
  // Parse the input value as an integer, or null if not present
  const assetId = assetInput && assetInput.value ? parseInt(assetInput.value, 10) : null;
  // Clear the asset table before displaying results
  clearTableRows('customerGeneratorTable');
  // If the asset ID is invalid, show an alert and stop
  if (!assetId || assetId <= 0) {
    alert('Enter a valid relationship ID to search.');
    return;
  }
  // Fetch the asset by ID from the backend
  getAssetById(assetId).then(data => {
    // If an asset is found, insert it into the table
    if (data && data.asset_id) {
      insertAsset(
        data.asset_id,
        data.customer_id,
        data.generator_id,
        data.generator_qtd,
        data.installation_date
      );
    } else {
      // If not found, show an alert
      alert('Relationship not found.');
    }
  }).catch(() => {
    // If an error occurs, show an alert
    alert('Error searching for the relationship.');
  });
}

// =============================================================================
// API Client
// =============================================================================

// Write requests return a common { error, message, rawDetail } shape to UI workflows.

// Read operations
// Collection reads also own their table refresh to keep callers simple.
/** Fetch and render every customer record. */
const getCustomers = async () => {
  // Clear the customer table before loading new data
  document.getElementById('customerTable').getElementsByTagName('tbody')[0].innerHTML = '';
  // Fetch the list of customers from the API
  return fetch(`${API_BASE}/customers`)
    .then((response) => response.json()) // Parse the response as JSON
    .then((data) => {
      // For each customer, insert a row into the table
      data.customers.forEach(item =>
        insertCustomer(item.customer_id, item.name, item.email, item.tx_id)
      );
    })
    .catch((error) => {
      // Log any errors to the console
      console.error('Error:', error);
    });
}


/** Fetch generators, update the shared cache, and render their table rows. */
const getGenerators = async () => {
  // Clear the generator table before loading new data
  clearTableRows('generatorTable');
  // Fetch the list of generators from the API
  return fetch(`${API_BASE}/hydrogen-generators`)
    .then((response) => response.json()) // Parse the response as JSON
    .then((data) => {
      availableGenerators = data.generators;
      refreshShippingGeneratorOptions();
      // For each generator, insert a row into the table
      data.generators.forEach(item =>
        insertGenerator(
          item.generator_id,
          item.serial_number,
          item.acquisition_type,
          item.stack_type,
          item.number_of_cells,
          item.stack_voltage,
          item.current_density,
          (item.stack_voltage / item.number_of_cells).toFixed(2),
          item.length_in,
          item.width_in,
          item.height_in,
          item.weight_lb
        )
      );
    })
    .catch((error) => {
      // Log any errors to the console
      console.error('Error:', error);
    });
}


/** Fetch and render every customer-generator relationship. */
const getAssets = async () => {
  // Clear the asset-link table before loading new data
  clearTableRows('customerGeneratorTable');
  // Fetch the list of asset links from the API
  return fetch(`${API_BASE}/assets`)
    .then((response) => response.json()) // Parse the response as JSON
    .then((data) => {
      // For each asset, insert a row into the table
      data.assets.forEach(item =>
        insertAsset(
          item.asset_id,
          item.customer_id,
          item.generator_id,
          item.generator_qtd,
          item.installation_date
        )
      );
    })
    .catch((error) => {
      // Log any errors to the console
      console.error('Error:', error);
    });
}


/** Fetch one customer by primary key, returning null for missing or failed reads. */
const getCustomerById = async (customerId) => {
  // Send a GET request to fetch a customer by ID
  return fetch(`${API_BASE}/customer?customer_id=${customerId}`)
    .then(async (response) => {
      // If the response is not OK, return null
      if (!response.ok) return null;
      // Parse and return the response as JSON
      return response.json();
    })
    .catch((error) => {
      // Log any errors and return null
      console.error('Error:', error);
      return null;
    });
}


/** Fetch one generator by URL-encoded serial, returning null when unavailable. */
const getGeneratorBySerial = async (serialNumber) => {
  // Send a GET request to fetch a generator by serial number
  return fetch(`${API_BASE}/hydrogen-generator?serial_number=${encodeURIComponent(serialNumber)}`)
    .then(async (response) => {
      // If the response is not OK, return null
      if (!response.ok) return null;
      // Parse and return the response as JSON
      return response.json();
    })
    .catch((error) => {
      // Log any errors and return null
      console.error('Error:', error);
      return null;
    });
}


/** Fetch one relationship by primary key, returning null when unavailable. */
const getAssetById = async (assetId) => {
  // Send a GET request to fetch an asset by ID
  return fetch(`${API_BASE}/asset?asset_id=${assetId}`)
    .then(async (response) => {
      // If the response is not OK, return null
      if (!response.ok) return null;
      // Parse and return the response as JSON
      return response.json();
    })
    .catch((error) => {
      // Log any errors and return null
      console.error('Error:', error);
      return null;
    });
}


// Create operations
/** Create a customer and normalize API or network errors for the form workflow. */
const postCustomer = async (name, email, txId) => {
  // Create a FormData object to send form fields
  const formData = new FormData();
  // Append the name field
  formData.append('name', name);
  // Append the email field
  formData.append('email', email);
  // Append the tax ID field
  formData.append('tx_id', txId);

  // Send a POST request to create a new customer
  return fetch(`${API_BASE}/customer`, {
    method: 'post',
    body: formData
  })
    .then(async (response) => {
      // Parse the response as JSON
      const data = await response.json();
      // If the response is not OK, return an error object with details
      if (!response.ok) {
        return {
          error: true,
          message: extractErrorMessage(data, 'Error registering the customer.'),
          rawDetail: extractRawDetail(data)
        };
      }
      // If successful, return the data
      return data;
    })
    .catch((error) => {
      // Log any errors and return a generic error object
      console.error('Error:', error);
      return { error: true, message: 'Failed to communicate with the server.' };
    });
}


/** Create a generator from validated technical and shipping measurements. */
const postGenerator = async (serial, acquisition, stackType, cells, voltage, current, length, width, height, weight) => {
  // Create a FormData object to send form fields
  const formData = new FormData();
  // Append the serial number field
  formData.append('serial_number', serial);
  // Append the acquisition type field
  formData.append('acquisition_type', acquisition);
  // Append the stack type field
  formData.append('stack_type', stackType);
  // Append the number of cells field
  formData.append('number_of_cells', cells);
  // Append the stack voltage field
  formData.append('stack_voltage', voltage);
  // Append the current density field
  formData.append('current_density', current);
  formData.append('length_in', length);
  formData.append('width_in', width);
  formData.append('height_in', height);
  formData.append('weight_lb', weight);

  // Send a POST request to create a new generator
  return fetch(`${API_BASE}/hydrogen-generator`, {
    method: 'post',
    body: formData
  })
    .then(async (response) => {
      // Parse the response as JSON
      const data = await response.json();
      // If the response is not OK, return an error object with details
      if (!response.ok) {
        return {
          error: true,
          message: extractErrorMessage(data, 'Error registering the generator.'),
          rawDetail: extractRawDetail(data)
        };
      }
      // If successful, return the data
      return data;
    })
    .catch((error) => {
      // Log any errors and return a generic error object
      console.error('Error:', error);
      return { error: true, message: 'Failed to communicate with the server.' };
    });
}


/** Create a relationship; omit an empty date so the ORM can apply its default. */
const postAsset = async (customerId, generatorId, generatorQtd, installationDate) => {
  // Create a FormData object to send form fields
  const formData = new FormData();
  // Append the customer ID field
  formData.append('customer_id', customerId);
  // Append the generator ID field
  formData.append('generator_id', generatorId);
  // Append the generator quantity field
  formData.append('generator_qtd', generatorQtd);
  // If installation date is provided, append it
  if (installationDate) {
    formData.append('installation_date', installationDate);
  }

  // Send a POST request to create a new asset link
  return fetch(`${API_BASE}/asset`, {
    method: 'post',
    body: formData
  })
    .then(async (response) => {
      // Parse the response as JSON
      const data = await response.json();
      // If the response is not OK, return an error object with details
      if (!response.ok) {
        return {
          error: true,
          message: extractErrorMessage(data, 'Error creating the customer-generator relationship.'),
          rawDetail: extractRawDetail(data)
        };
      }
      // If successful, return the data
      return data;
    })
    .catch((error) => {
      // Log any errors and return a generic error object
      console.error('Error:', error);
      return { error: true, message: 'Failed to communicate with the server.' };
    });
}


// Update operations
/** Convert a PUT response into either entity data or the shared error shape. */
const parseUpdateResponse = async (response, fallbackMessage) => {
  const data = await response.json();
  if (!response.ok) {
    return {
      error: true,
      message: extractErrorMessage(data, fallbackMessage),
      rawDetail: extractRawDetail(data)
    };
  }
  return data;
};


/** Replace customer fields while the stable customer ID remains in the query. */
const putCustomer = async (customerId, name, email, txId) => {
  const formData = new FormData();
  formData.append('name', name);
  formData.append('email', email);
  formData.append('tx_id', txId);

  try {
    const response = await fetch(`${API_BASE}/customer?customer_id=${customerId}`, {
      method: 'put',
      body: formData
    });
    return parseUpdateResponse(response, 'Error updating the customer.');
  } catch (error) {
    console.error('Error:', error);
    return { error: true, message: 'Failed to communicate with the server.' };
  }
};


/**
 * Replace generator fields using its pre-edit serial as the lookup key.
 * The submitted serial may differ because changing the serial is supported.
 */
const putGenerator = async (currentSerial, values) => {
  const formData = new FormData();
  formData.append('serial_number', values.serial);
  formData.append('acquisition_type', values.acquisition);
  formData.append('stack_type', values.stackType);
  formData.append('number_of_cells', values.cells);
  formData.append('stack_voltage', values.voltage);
  formData.append('current_density', values.current);
  formData.append('length_in', values.length);
  formData.append('width_in', values.width);
  formData.append('height_in', values.height);
  formData.append('weight_lb', values.weight);

  try {
    const response = await fetch(
      `${API_BASE}/hydrogen-generator?serial_number=${encodeURIComponent(currentSerial)}`,
      { method: 'put', body: formData }
    );
    return parseUpdateResponse(response, 'Error updating the generator.');
  } catch (error) {
    console.error('Error:', error);
    return { error: true, message: 'Failed to communicate with the server.' };
  }
};


/** Replace a relationship while preserving its stable asset ID. */
const putAsset = async (assetId, customerId, generatorId, generatorQtd, installationDate) => {
  const formData = new FormData();
  formData.append('customer_id', customerId);
  formData.append('generator_id', generatorId);
  formData.append('generator_qtd', generatorQtd);
  if (installationDate) formData.append('installation_date', installationDate);

  try {
    const response = await fetch(`${API_BASE}/asset?asset_id=${assetId}`, {
      method: 'put',
      body: formData
    });
    return parseUpdateResponse(response, 'Error updating the relationship.');
  } catch (error) {
    console.error('Error:', error);
    return { error: true, message: 'Failed to communicate with the server.' };
  }
};


// Delete operations
/** Delete a customer by ID and return normalized API errors to the row action. */
const deleteCustomer = async (id) => {
  // Send a DELETE request to remove a customer by ID
  return fetch(`${API_BASE}/customer?customer_id=${id}`, { method: 'delete' })
    .then(async (response) => {
      // Parse the response as JSON
      const data = await response.json();
      // If the response is not OK, return an error object with details
      if (!response.ok) {
        return { error: true, message: extractErrorMessage(data, 'Error deleting the customer.') };
      }
      // If successful, return the data
      return data;
    })
    .catch((error) => {
      // Log any errors and return a generic error object
      console.error('Error:', error);
      return { error: true, message: 'Failed to communicate with the server.' };
    });
}


/** Delete a generator by its URL-encoded serial number. */
const deleteGenerator = async (serialNumber) => {
  // Send a DELETE request to remove a generator by serial number
  return fetch(`${API_BASE}/hydrogen-generator?serial_number=${encodeURIComponent(serialNumber)}`, {
    method: 'delete'
  })
    .then(async (response) => {
      // Parse the response as JSON
      const data = await response.json();
      // If the response is not OK, return an error object with details
      if (!response.ok) {
        return { error: true, message: extractErrorMessage(data, 'Error deleting the generator.') };
      }
      // If successful, return the data
      return data;
    })
    .catch((error) => {
      // Log any errors and return a generic error object
      console.error('Error:', error);
      return { error: true, message: 'Failed to communicate with the server.' };
    });
}


/** Delete a customer-generator relationship by asset ID. */
const deleteAsset = async (assetId) => {
  // Send a DELETE request to remove an asset by ID
  return fetch(`${API_BASE}/asset?asset_id=${assetId}`, { method: 'delete' })
    .then(async (response) => {
      // Parse the response as JSON
      const data = await response.json();
      // If the response is not OK, return an error object with details
      if (!response.ok) {
        return { error: true, message: extractErrorMessage(data, 'Error deleting the relationship.') };
      }
      // If successful, return the data
      return data;
    })
    .catch((error) => {
      // Log any errors and return a generic error object
      console.error('Error:', error);
      return { error: true, message: 'Failed to communicate with the server.' };
    });
}


// =============================================================================
// Table Rendering
// =============================================================================

/**
 * Create a fixed-size accessible table action button.
 * @param {string} symbol Visible icon glyph.
 * @param {string} label Tooltip and accessible name.
 * @param {string} className Action-specific styling hook.
 * @param {Function} clickHandler Action callback.
 * @returns {HTMLButtonElement} Configured button element.
 */
const createIconButton = (symbol, label, className, clickHandler) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = symbol;
  button.className = `icon-button ${className}`;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.addEventListener('click', clickHandler);
  return button;
};

/** Add consistently ordered Edit and Delete actions to a table cell. */
const appendRowActions = (cell, editHandler, deleteHandler, resourceName) => {
  cell.className = 'action-column';
  const actions = document.createElement('div');
  actions.className = 'row-actions';
  actions.appendChild(createIconButton('✎', `Edit ${resourceName}`, 'edit-btn', editHandler));
  actions.appendChild(createIconButton('×', `Delete ${resourceName}`, 'delete-btn', deleteHandler));
  cell.appendChild(actions);
};

/** Render one customer row with edit and delete actions. */
const insertCustomer = (id, name, email, txId) => {
  // Get the tbody of the customer table
  const table = document.getElementById('customerTable').getElementsByTagName('tbody')[0];
  // Insert a new row at the end of the table
  const row = table.insertRow();

  // Insert cells for each customer field
  row.insertCell(0).textContent = id;
  row.insertCell(1).textContent = name;
  row.insertCell(2).textContent = email;
  row.insertCell(3).textContent = txId;

  const actionCell = row.insertCell(4);
  appendRowActions(actionCell, () => {
    startCustomerEdit({ customer_id: id, name, email, tx_id: txId });
  }, async () => {
    // Confirm before deleting
    if (confirm('Are you sure you want to delete this customer?')) {
      // Call the deleteCustomer function
      const result = await deleteCustomer(id);
      // If there was an error, show an alert
      if (result && result.error) {
        alert(result.message);
      } else {
        // Remove the row from the table
        row.remove();
        alert('Customer deleted successfully!');
      }
    }
  }, 'customer');
}


/** Render one generator row and retain all values needed to prefill editing. */
const insertGenerator = (id, serial, acquisitionType, stackType, cells, voltage, currentDensity, vPerCell, length, width, height, weight) => {
  // Get the tbody of the generator table
  const table = document.getElementById('generatorTable').getElementsByTagName('tbody')[0];
  // Insert a new row at the end of the table
  const row = table.insertRow();

  // Insert cells for each generator field
  row.insertCell(0).textContent = id;
  row.insertCell(1).textContent = serial;
  row.insertCell(2).textContent = acquisitionType;
  row.insertCell(3).textContent = stackType;
  row.insertCell(4).textContent = cells;
  row.insertCell(5).textContent = voltage;
  row.insertCell(6).textContent = currentDensity;
  row.insertCell(7).textContent = vPerCell;
  row.insertCell(8).textContent = length;
  row.insertCell(9).textContent = width;
  row.insertCell(10).textContent = height;
  row.insertCell(11).textContent = weight;

  const actionCell = row.insertCell(12);
  appendRowActions(actionCell, () => {
    startGeneratorEdit({
      serial_number: serial,
      acquisition_type: acquisitionType,
      stack_type: stackType,
      number_of_cells: cells,
      stack_voltage: voltage,
      current_density: currentDensity,
      length_in: length,
      width_in: width,
      height_in: height,
      weight_lb: weight,
    });
  }, async () => {
    // Confirm before deleting
    if (confirm('Are you sure you want to delete this generator?')) {
      // Call the deleteGenerator function
      const result = await deleteGenerator(serial);
      // If there was an error, show an alert
      if (result && result.error) {
        alert(result.message);
      } else {
        // Remove the row from the table
        row.remove();
        // Keep shipping options consistent with the row removed from the database.
        availableGenerators = availableGenerators.filter(generator => generator.generator_id !== id);
        refreshShippingGeneratorOptions();
        alert('Generator deleted successfully!');
      }
    }
  }, 'generator');
}


/** Render one relationship row with a localized installation date. */
const insertAsset = (assetId, customerId, generatorId, generatorQtd, installationDate) => {
  // Get the tbody of the asset-link table
  const table = document.getElementById('customerGeneratorTable').getElementsByTagName('tbody')[0];
  // Insert a new row at the end of the table
  const row = table.insertRow();

  // Insert cells for each asset field
  row.insertCell(0).textContent = assetId;
  row.insertCell(1).textContent = customerId;
  row.insertCell(2).textContent = generatorId;
  row.insertCell(3).textContent = generatorQtd;
  // Format the installation date or show a dash if missing
  row.insertCell(4).textContent = installationDate
    ? new Date(installationDate).toLocaleDateString('en-US')
    : '—';

  const actionCell = row.insertCell(5);
  appendRowActions(actionCell, () => {
    startAssetEdit({
      asset_id: assetId,
      customer_id: customerId,
      generator_id: generatorId,
      generator_qtd: generatorQtd,
      installation_date: installationDate,
    });
  }, async () => {
    // Confirm before deleting
    if (confirm('Are you sure you want to delete this relationship?')) {
      // Call the deleteAsset function
      const result = await deleteAsset(assetId);
      // If there was an error, show an alert
      if (result && result.error) {
        alert(result.message);
      } else {
        // Remove the row from the table
        row.remove();
        alert('Relationship deleted successfully!');
      }
    }
  }, 'relationship');
}


// =============================================================================
// Customer Form Workflow
// =============================================================================

// List of input IDs for customer form
const CUSTOMER_FIELDS = ['custName', 'custEmail', 'custTaxId'];

// Map backend validation locations to the corresponding customer controls.
const CUSTOMER_FIELD_MAP = {
  name: 'custName',
  email: 'custEmail',
  tx_id: 'custTaxId',
};

/** Prefill the customer form and retain the target ID for the later PUT request. */
const startCustomerEdit = (customer) => {
  editState.customerId = customer.customer_id;
  document.getElementById('custName').value = customer.name;
  document.getElementById('custEmail').value = customer.email;
  document.getElementById('custTaxId').value = customer.tx_id;
  document.getElementById('customerSubmitButton').textContent = 'Save Customer Changes';
  document.getElementById('cancelCustomerEdit').hidden = false;
  document.getElementById('customerForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.getElementById('custName').focus();
};

/** Restore the customer form to its record-creation state. */
const cancelCustomerEdit = () => {
  editState.customerId = null;
  clearFieldErrors(CUSTOMER_FIELDS);
  document.getElementById('customerForm').reset();
  document.getElementById('customerSubmitButton').textContent = 'Register Customer';
  document.getElementById('cancelCustomerEdit').hidden = true;
};

/**
 * Apply client-side customer validation before a network request.
 * @param {object} values Normalized form values.
 * @param {boolean} showAlert Whether to supplement inline errors with an alert.
 * @returns {boolean} True when every field satisfies the API contract.
 */
const validateCustomerFields = (values, showAlert = false) => {
  // Name is required and must be at least 2 characters
  if (!values.name) {
    markFieldError('custName', 'Enter the name/company.');
    if (showAlert) alert('Check the Name/Company field.');
    return false;
  }
  if (values.name.length < 2) {
    markFieldError('custName', 'The name must contain at least 2 characters.');
    if (showAlert) alert('Check the Name/Company field.');
    return false;
  }
  // Email is required and must look like an email
  if (!values.email) {
    markFieldError('custEmail', 'Enter an email address.');
    if (showAlert) alert('Check the Email field.');
    return false;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) {
    markFieldError('custEmail', 'Invalid email format.');
    if (showAlert) alert('Check the Email field.');
    return false;
  }
  // Tax ID is required and must match 000-00-0000
  if (!values.txId) {
    markFieldError('custTaxId', 'Enter the Tax ID.');
    if (showAlert) alert('Check the Tax ID field.');
    return false;
  }
  if (!/^\d{3}-\d{2}-\d{4}$/.test(values.txId)) {
    markFieldError('custTaxId', 'The Tax ID must follow the format 000-00-0000.');
    if (showAlert) alert('Check the Tax ID field. Expected format: 000-00-0000.');
    return false;
  }
  // All fields are valid
  return true;
};

/** Validate and submit the customer form in its current create or edit mode. */
const newCustomer = async () => {
  // Clear any previous field errors
  clearFieldErrors(CUSTOMER_FIELDS);

  // Read values from form fields
  const name = document.getElementById('custName').value.trim();
  const email = document.getElementById('custEmail').value.trim();
  const txId = document.getElementById('custTaxId').value.trim();
  const customerValues = { name, email, txId };
  // Validate before sending
  if (!validateCustomerFields(customerValues, false)) return;
  const isEditing = editState.customerId !== null;
  const result = isEditing
    ? await putCustomer(editState.customerId, name, email, txId)
    : await postCustomer(name, email, txId);
  if (result && result.error) {
    let highlighted = false;
    // Try to highlight the field with error from backend
    if (result.rawDetail && Array.isArray(result.rawDetail)) {
      result.rawDetail.forEach(err => {
        const loc = err.loc || [];
        const fieldName = loc.find(l => CUSTOMER_FIELD_MAP[l]);
        if (fieldName) {
          markFieldError(CUSTOMER_FIELD_MAP[fieldName], err.msg || 'Invalid value.');
          highlighted = true;
        }
      });
    }
    // If not, try to guess from error message
    if (!highlighted) {
      for (const [apiName, inputId] of Object.entries(CUSTOMER_FIELD_MAP)) {
        if (result.message && result.message.toLowerCase().includes(apiName.replace(/_/g, ' '))) {
          markFieldError(inputId, result.message);
          highlighted = true;
          break;
        }
      }
    }
    // If still not, run local validation to show a field
    if (!highlighted) {
      if (!validateCustomerFields(customerValues, true)) return;
      if (!result.message || result.message === 'Error registering the customer.') {
        alert('Unable to register the customer. Check the provided fields.');
        return;
      }
    }
    // Show the error message
    alert(result.message);
  } else if (result && result.customer_id) {
    clearFieldErrors(CUSTOMER_FIELDS);
    if (isEditing) {
      cancelCustomerEdit();
      await getCustomers();
      alert('Customer updated successfully!');
      return;
    }

    const fetchedCustomer = await getCustomerById(result.customer_id);
    const customerData = fetchedCustomer || result;
    insertCustomer(
      customerData.customer_id,
      customerData.name,
      customerData.email,
      customerData.tx_id
    );
    // Reset the form
    document.getElementById('customerForm').reset();
    alert('Customer registered successfully!');
  }
}


// =============================================================================
// Generator Form Workflow
// =============================================================================

// List of input IDs for generator form
const GENERATOR_FIELDS = ['newSerial', 'newAcquisition', 'newGenType', 'newCells', 'newVoltage', 'newCurrent', 'newLength', 'newWidth', 'newHeight', 'newWeight'];

// Map backend validation locations to the corresponding generator controls.
const GENERATOR_FIELD_MAP = {
  serial_number: 'newSerial',
  acquisition_type: 'newAcquisition',
  stack_type: 'newGenType',
  number_of_cells: 'newCells',
  stack_voltage: 'newVoltage',
  current_density: 'newCurrent',
  length_in: 'newLength',
  width_in: 'newWidth',
  height_in: 'newHeight',
  weight_lb: 'newWeight',
};

/** Prefill all generator fields and retain the original serial as the PUT key. */
const startGeneratorEdit = (generator) => {
  editState.generatorSerial = generator.serial_number;
  document.getElementById('newSerial').value = generator.serial_number;
  document.getElementById('newAcquisition').value = generator.acquisition_type;
  document.getElementById('newGenType').value = generator.stack_type;
  document.getElementById('newCells').value = generator.number_of_cells;
  document.getElementById('newVoltage').value = generator.stack_voltage;
  document.getElementById('newCurrent').value = generator.current_density;
  document.getElementById('newLength').value = generator.length_in;
  document.getElementById('newWidth').value = generator.width_in;
  document.getElementById('newHeight').value = generator.height_in;
  document.getElementById('newWeight').value = generator.weight_lb;
  document.getElementById('generatorSubmitButton').textContent = 'Save Generator Changes';
  document.getElementById('cancelGeneratorEdit').hidden = false;
  document.getElementById('generatorForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.getElementById('newSerial').focus();
};

/** Restore the generator form to its record-creation state. */
const cancelGeneratorEdit = () => {
  editState.generatorSerial = null;
  clearFieldErrors(GENERATOR_FIELDS);
  document.getElementById('generatorForm').reset();
  document.getElementById('generatorSubmitButton').textContent = 'Register Generator';
  document.getElementById('cancelGeneratorEdit').hidden = true;
};

// Regex to check serial number format
const SERIAL_NUMBER_REGEX = /^GEN-\d{4}$/;

/**
 * Validate generator identity, operating values, and carrier parcel limits.
 * The longest dimension is treated as parcel length for the girth calculation.
 */
const validateGeneratorFields = (values, showAlert = false) => {
  // Serial is required and must match GEN-0000
  if (!values.serial) {
    markFieldError('newSerial', 'Enter the serial number.');
    if (showAlert) alert('Check the Serial Number field.');
    return false;
  }
  if (!SERIAL_NUMBER_REGEX.test(values.serial)) {
    markFieldError('newSerial', 'The serial number must follow the format GEN-0000 (e.g., GEN-0001).');
    if (showAlert) alert('Check the Serial Number field. Expected format: GEN-0000 (e.g., GEN-0001).');
    return false;
  }
  if (values.serial.length > 50) {
    markFieldError('newSerial', 'The serial number must not exceed 50 characters.');
    if (showAlert) alert('Check the Serial Number field.');
    return false;
  }

  // Dropdown selections are mandatory and must map to allowed enums.
  if (!values.acquisition) {
    markFieldError('newAcquisition', 'Select an acquisition type.');
    if (showAlert) alert('Check the Acquisition Type field.');
    return false;
  }

  if (!values.stackType) {
    markFieldError('newGenType', 'Select a generator type.');
    if (showAlert) alert('Check the Generator Type field.');
    return false;
  }

  // Numeric constraints mirror backend schema limits.
  if (!values.cells || Number(values.cells) <= 0) {
    markFieldError('newCells', 'The number of cells must be greater than zero.');
    if (showAlert) alert('Check the Number of Cells field.');
    return false;
  }
  if (Number(values.cells) > 5000) {
    markFieldError('newCells', 'The number of cells must not exceed 5,000.');
    if (showAlert) alert('Check the Number of Cells field.');
    return false;
  }
  // Voltage must be > 0 and <= 2000
  if (!values.voltage || Number(values.voltage) <= 0) {
    markFieldError('newVoltage', 'The voltage must be greater than zero.');
    if (showAlert) alert('Check the Stack Voltage field.');
    return false;
  }
  if (Number(values.voltage) > 2000) {
    markFieldError('newVoltage', 'The voltage must not exceed 2,000 V.');
    if (showAlert) alert('Check the Stack Voltage field.');
    return false;
  }
  // Current must be > 0 and <= 5000
  if (!values.current || Number(values.current) <= 0) {
    markFieldError('newCurrent', 'The current density must be greater than zero.');
    if (showAlert) alert('Check the Current Density field.');
    return false;
  }
  if (Number(values.current) > 5000) {
    markFieldError('newCurrent', 'The current density must not exceed 5,000 A/cm².');
    if (showAlert) alert('Check the Current Density field.');
    return false;
  }
  const measurements = [
    ['length', 'newLength', 'Length', MAX_PARCEL_SIDE_IN, 'in'],
    ['width', 'newWidth', 'Width', MAX_PARCEL_SIDE_IN, 'in'],
    ['height', 'newHeight', 'Height', MAX_PARCEL_SIDE_IN, 'in'],
    ['weight', 'newWeight', 'Weight', MAX_PARCEL_WEIGHT_LB, 'lb'],
  ];
  for (const [valueName, fieldId, label, maximum, unit] of measurements) {
    if (!values[valueName] || Number(values[valueName]) <= 0) {
      markFieldError(fieldId, `${label} must be greater than zero.`);
      if (showAlert) alert(`Check the ${label} field.`);
      return false;
    }
    if (Number(values[valueName]) > maximum) {
      markFieldError(fieldId, `${label} must not exceed ${maximum} ${unit}.`);
      if (showAlert) alert(`Check the ${label} field.`);
      return false;
    }
  }

  const parcelDimensions = [
    { value: Number(values.length), fieldId: 'newLength' },
    { value: Number(values.width), fieldId: 'newWidth' },
    { value: Number(values.height), fieldId: 'newHeight' },
  ].sort((first, second) => second.value - first.value);
  const lengthPlusGirth = parcelDimensions[0].value
    + 2 * (parcelDimensions[1].value + parcelDimensions[2].value);
  if (lengthPlusGirth > MAX_PARCEL_LENGTH_PLUS_GIRTH_IN) {
    markFieldError(
      parcelDimensions[0].fieldId,
      `Length plus girth is ${lengthPlusGirth} in; maximum is ${MAX_PARCEL_LENGTH_PLUS_GIRTH_IN} in.`
    );
    if (showAlert) alert('Generator dimensions exceed the standard parcel size limit.');
    return false;
  }
  // All fields are valid
  return true;
};

/** Validate and submit the generator form in its current create or edit mode. */
const newGenerator = async () => {
  clearFieldErrors(GENERATOR_FIELDS);
  // Get values from form
  const serialInput = document.getElementById('newSerial');
  const serial = serialInput.value.trim().toUpperCase();
  serialInput.value = serial;
  const acquisition = document.getElementById('newAcquisition').value;
  const stackType = document.getElementById('newGenType').value;
  const cells = document.getElementById('newCells').value;
  const voltage = document.getElementById('newVoltage').value;
  const current = document.getElementById('newCurrent').value;
  const length = document.getElementById('newLength').value;
  const width = document.getElementById('newWidth').value;
  const height = document.getElementById('newHeight').value;
  const weight = document.getElementById('newWeight').value;
  const generatorValues = { serial, acquisition, stackType, cells, voltage, current, length, width, height, weight };
  // Validate before sending
  if (!validateGeneratorFields(generatorValues, false)) return;
  const isEditing = editState.generatorSerial !== null;
  const result = isEditing
    ? await putGenerator(editState.generatorSerial, generatorValues)
    : await postGenerator(serial, acquisition, stackType, cells, voltage, current, length, width, height, weight);
  if (result && result.error) {
    // Try to highlight the specific field from API validation errors
    let highlighted = false;
    // Try to highlight the field with error from backend
    if (result.rawDetail && Array.isArray(result.rawDetail)) {
      result.rawDetail.forEach(err => {
        const loc = err.loc || [];
        const fieldName = loc.find(l => GENERATOR_FIELD_MAP[l]);
        if (fieldName) {
          markFieldError(GENERATOR_FIELD_MAP[fieldName], err.msg || 'Invalid value.');
          highlighted = true;
        }
      });
    }
    // If not, try to guess from error message
    if (!highlighted) {
      // Check if message mentions a known field
      for (const [apiName, inputId] of Object.entries(GENERATOR_FIELD_MAP)) {
        if (result.message && result.message.toLowerCase().includes(apiName.replace(/_/g, ' '))) {
          markFieldError(inputId, result.message);
          highlighted = true;
          break;
        }
      }
    }
    // If still not, run local validation to show a field
    if (!highlighted) {
      if (!validateGeneratorFields(generatorValues, true)) return;
      if (!result.message || result.message === 'Error registering the generator.') {
        alert('Unable to register the generator. Check the provided fields.');
        return;
      }
    }
    // Show the error message
    alert(result.message);
  } else if (result && result.generator_id) {
    if (isEditing) {
      cancelGeneratorEdit();
      await getGenerators();
      alert('Generator updated successfully!');
      return;
    }

    const fetchedGenerator = await getGeneratorBySerial(result.serial_number);
    const generatorData = fetchedGenerator || result;
    insertGenerator(
      generatorData.generator_id,
      generatorData.serial_number,
      generatorData.acquisition_type,
      generatorData.stack_type,
      generatorData.number_of_cells,
      generatorData.stack_voltage,
      generatorData.current_density,
      (generatorData.stack_voltage / generatorData.number_of_cells).toFixed(2),
      generatorData.length_in,
      generatorData.width_in,
      generatorData.height_in,
      generatorData.weight_lb
    );
    availableGenerators.push(generatorData);
    refreshShippingGeneratorOptions();
    // Reset the form
    document.getElementById('generatorForm').reset();
    alert('Generator registered successfully!');
  }
}


// =============================================================================
// Relationship Form Workflow
// =============================================================================

// List of input IDs for asset form
const ASSET_FIELDS = ['cgCustomerId', 'cgGeneratorId', 'cgGeneratorQtd', 'cgInstallationDate'];

// Map backend validation locations to the corresponding relationship controls.
const ASSET_FIELD_MAP = {
  customer_id: 'cgCustomerId',
  generator_id: 'cgGeneratorId',
  generator_qtd: 'cgGeneratorQtd',
  installation_date: 'cgInstallationDate',
};

/** Prefill relationship fields and normalize an API timestamp for the date input. */
const startAssetEdit = (asset) => {
  editState.assetId = asset.asset_id;
  document.getElementById('cgCustomerId').value = asset.customer_id;
  document.getElementById('cgGeneratorId').value = asset.generator_id;
  document.getElementById('cgGeneratorQtd').value = asset.generator_qtd;
  document.getElementById('cgInstallationDate').value = asset.installation_date
    ? String(asset.installation_date).slice(0, 10)
    : '';
  document.getElementById('assetSubmitButton').textContent = 'Save Relationship Changes';
  document.getElementById('cancelAssetEdit').hidden = false;
  document.getElementById('customerGeneratorForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.getElementById('cgCustomerId').focus();
};

/** Restore the relationship form to its record-creation state. */
const cancelAssetEdit = () => {
  editState.assetId = null;
  clearFieldErrors(ASSET_FIELDS);
  document.getElementById('customerGeneratorForm').reset();
  document.getElementById('assetSubmitButton').textContent = 'Create Relationship';
  document.getElementById('cancelAssetEdit').hidden = true;
};

/** Validate and submit the relationship form in its current create or edit mode. */
const newCustomerGenerator = async () => {
  // Clear any previous field errors
  clearFieldErrors(ASSET_FIELDS);
  // Get values from form
  const customerId = document.getElementById('cgCustomerId').value;
  const generatorId = document.getElementById('cgGeneratorId').value;
  const generatorQtd = document.getElementById('cgGeneratorQtd').value;
  const installationDate = document.getElementById('cgInstallationDate').value;
  let hasError = false;
  // Check required fields
  if (!customerId || Number(customerId) <= 0) { markFieldError('cgCustomerId', 'Enter the customer ID.'); hasError = true; }
  if (!generatorId || Number(generatorId) <= 0) { markFieldError('cgGeneratorId', 'Enter the generator ID.'); hasError = true; }
  if (!generatorQtd || Number(generatorQtd) <= 0) { markFieldError('cgGeneratorQtd', 'Enter a valid quantity.'); hasError = true; }

  // If any validation failed, stop
  if (hasError) return;
  const isEditing = editState.assetId !== null;
  const result = isEditing
    ? await putAsset(editState.assetId, customerId, generatorId, generatorQtd, installationDate)
    : await postAsset(customerId, generatorId, generatorQtd, installationDate);
  if (result && result.error) {
    let highlighted = false;
    // Try to highlight the field with error from backend
    if (result.rawDetail && Array.isArray(result.rawDetail)) {
      result.rawDetail.forEach(err => {
        const loc = err.loc || [];
        const fieldName = loc.find(l => ASSET_FIELD_MAP[l]);
        if (fieldName) {
          markFieldError(ASSET_FIELD_MAP[fieldName], err.msg || 'Invalid value.');
          highlighted = true;
        }
      });
    }
    // If not, try to guess from error message
    if (!highlighted) {
      for (const [apiName, inputId] of Object.entries(ASSET_FIELD_MAP)) {
        if (result.message && result.message.toLowerCase().includes(apiName.replace(/_/g, ' '))) {
          markFieldError(inputId, result.message);
          highlighted = true;
          break;
        }
      }
    }
    // Show the error message
    alert(result.message);
  } else if (result && result.asset_id) {
    clearFieldErrors(ASSET_FIELDS);
    if (isEditing) {
      cancelAssetEdit();
      await getAssets();
      alert('Relationship updated successfully!');
      return;
    }

    const fetchedAsset = await getAssetById(result.asset_id);
    const assetData = fetchedAsset || result;
    insertAsset(
      assetData.asset_id,
      assetData.customer_id,
      assetData.generator_id,
      assetData.generator_qtd,
      assetData.installation_date
    );
    // Reset the form
    document.getElementById('customerGeneratorForm').reset();
    alert('Relationship created successfully!');
  }
}

// =============================================================================
// Shipping Quote Workflow
// =============================================================================

/**
 * Validate shipment data, reject freight-sized parcels locally, and request a quote.
 * The button and result surface expose progress while the asynchronous request runs.
 */
const calculateShippingQuote = async () => {

  const form = document.getElementById('shippingQuoteForm');
  if (!form.reportValidity()) return;

  const generatorId = Number(document.getElementById('shippingGeneratorId').value);
  const generatorQuantity = Number(document.getElementById('shippingQuantity').value);

  if (!generatorId) {
    alert('Select a generator.');
    return;
  }

  if (!Number.isInteger(generatorQuantity) || generatorQuantity <= 0 || generatorQuantity > 100) {
    alert('Enter a generator quantity between 1 and 100.');
    return;
  }

  const generator = availableGenerators.find(item => item.generator_id === generatorId);
  if (generator && getParcelLengthPlusGirth(generator) > MAX_PARCEL_LENGTH_PLUS_GIRTH_IN) {
    const resultContainer = document.getElementById('shippingResult');
    resultContainer.style.display = 'block';
    resultContainer.innerHTML = `
      <h3>Freight Quote Required</h3>
      <p>This generator exceeds the ${MAX_PARCEL_LENGTH_PLUS_GIRTH_IN} in standard parcel size limit.</p>
      <p>Please request a freight shipping quote for this equipment.</p>
    `;
    return;
  }

    const payload = {
      origin_name: document.getElementById('originName').value.trim(),
      origin_street: document.getElementById('originStreet').value.trim(),
      origin_city: document.getElementById('originCity').value.trim(),
      origin_state: document.getElementById('originState').value.trim().toUpperCase(),
      origin_zip: document.getElementById('originZip').value.trim(),
      customer_name: document.getElementById('shipCustomerName').value.trim(),
      destination_street: document.getElementById('destinationStreet').value.trim(),
      destination_city: document.getElementById('destinationCity').value.trim(),
      destination_state: document.getElementById('destinationState').value.trim().toUpperCase(),
      destination_zip: document.getElementById('destinationZip').value.trim(),
      generator_id: generatorId,
      generator_quantity: generatorQuantity
    };

    const addressFields = [
      payload.origin_name,
      payload.origin_street,
      payload.origin_city,
      payload.origin_state,
      payload.origin_zip,
      payload.customer_name,
      payload.destination_street,
      payload.destination_city,
      payload.destination_state,
      payload.destination_zip
    ];
    const statePattern = /^[A-Z]{2}$/;
    const zipPattern = /^\d{5}(?:-\d{4})?$/;
    if (addressFields.some(value => !value)) {
      alert('Complete both the origin and destination addresses.');
      return;
    }
    if (!statePattern.test(payload.origin_state) || !statePattern.test(payload.destination_state)) {
      alert('Enter two-letter state codes for origin and destination.');
      return;
    }
    if (!zipPattern.test(payload.origin_zip) || !zipPattern.test(payload.destination_zip)) {
      alert('Enter valid ZIP or ZIP+4 codes for origin and destination.');
      return;
    }

    const resultContainer = document.getElementById("shippingResult");
    const calculateButton = document.getElementById('calculateShippingButton');
    calculateButton.disabled = true;
    calculateButton.textContent = 'Calculating...';
    resultContainer.style.display = 'block';
    resultContainer.textContent = 'Requesting available shipping rates...';

    try {

        const response = await fetch(
            `${API_BASE}/shipping-quote`,
            {
                method: "POST",

                headers: {
                    "Content-Type":
                        "application/json"
                },

                body: JSON.stringify(payload)
            }
        );

        const data =
            await response.json();

        if (!response.ok) {
          throw new Error(data.message || 'Unable to calculate the shipping quote.');
        }

        if (data.success) {

          const amount = Number(data.amount);
          const formattedCost = Number.isFinite(amount)
            ? new Intl.NumberFormat('en-US', {
              style: 'currency',
              currency: data.currency || 'USD'
              }).format(amount)
            : data.amount;

            resultContainer.innerHTML = `
              <h3>✅ Shipping Quote</h3>

              <p>
                Carrier:
                ${data.carrier}
              </p>

              <p>
                Service:
                ${data.service}
              </p>

              <p>
                Cost:
                ${formattedCost}
              </p>

              <p>
                Currency:
                ${data.currency}
              </p>

              ${data.estimated_days == null ? '' : `
              <p>
                Estimated Delivery:
                ${data.estimated_days} day${data.estimated_days === 1 ? '' : 's'}
              </p>`}
            `;

        } else {

          const messages = data.shippo_messages || [];

            resultContainer.innerHTML = `
              <h3>
                ⚠ No Shipping Quote Available
              </h3>

              <p>
                ${data.message}
              </p>

              <ul>
              ${messages
                .map(
                  msg =>
                    `<li>${msg.source || 'Shippo'}: ${msg.message || ''}</li>`
                )
                .join("")}

              </ul>
            `;
        }

    } catch (error) {

        console.error(error);
      resultContainer.textContent = error.message || 'Failed to connect to the backend.';
    } finally {
      calculateButton.disabled = false;
      calculateButton.textContent = 'Calculate Shipping Cost';
    }
};


// =============================================================================
// Application Initialization
// =============================================================================

window.addEventListener('DOMContentLoaded', () => {
  // Bind behavior only after every form and navigation control exists in the DOM.
  initializeTabs();

  document.getElementById('customerForm').addEventListener('submit', event => {
    event.preventDefault();
    newCustomer();
  });

  document.getElementById('generatorForm').addEventListener('submit', event => {
    event.preventDefault();
    newGenerator();
  });

  document.getElementById('customerGeneratorForm').addEventListener('submit', event => {
    event.preventDefault();
    newCustomerGenerator();
  });

  document.getElementById('cancelCustomerEdit').addEventListener('click', cancelCustomerEdit);
  document.getElementById('cancelGeneratorEdit').addEventListener('click', cancelGeneratorEdit);
  document.getElementById('cancelAssetEdit').addEventListener('click', cancelAssetEdit);

  document.getElementById('shippingQuoteForm').addEventListener('submit', event => {
    event.preventDefault();
    calculateShippingQuote();
  });

  document.getElementById('shippingGeneratorId').addEventListener('change', updateShippingMeasurements);
  document.getElementById('shippingQuantity').addEventListener('input', updateShippingMeasurements);
  document.getElementById('shippingQuoteForm').addEventListener('reset', () => {
    // Wait until the browser has restored each control's default value.
    setTimeout(() => {
      document.getElementById('shippingGeneratorId').selectedIndex = 0;
      updateShippingMeasurements();
      document.getElementById('shippingResult').style.display = 'none';
    }, 0);
  });
});

window.addEventListener('load', () => {
  // Initial reads populate all tables and the generator cache used by shipping.
  getCustomers();
  getGenerators();
  getAssets();
});