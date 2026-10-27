(function() {
  'use strict';

  var root = document.querySelector('[data-orders-bookings]');
  if (!root) {
    return;
  }
  var loadingIndicator = root.querySelector('[data-review-loading]');

  var MIN_LEN = 20;
  var MAX_LEN = 2000;
  var ENDPOINT = '/apps/bta-booking/reviews';
  var ORDER_STATUS_ENDPOINT = '/apps/bta-booking/reviews/order-status';
  var ORDER_STATUS_ENDPOINT_FALLBACK = '/apps/bta-booking/bta/reviews/order-status';

  function setReviewLoading(isLoading) {
    if (!loadingIndicator) {
      return;
    }
    loadingIndicator.hidden = !isLoading;
    root.classList.toggle('is-review-loading', isLoading);
  }

  function fetchEnvelope(url, options) {
    return fetch(url, Object.assign({
      credentials: 'same-origin',
      headers: {
        'Accept': 'application/json'
      }
    }, options || {}))
      .then(function(response) {
        var contentType = response.headers.get('content-type') || '';
        var isJson = contentType.indexOf('application/json') !== -1;
        var payloadPromise = isJson ? response.json().catch(function(error) {
          throw {
            code: 'PARSE_ERROR',
            message: 'Failed to parse JSON response',
            correlationId: null,
            raw: error
          };
        }) : response.text();

        return payloadPromise.then(function(payload) {
          if (!response.ok) {
            if (payload && typeof payload === 'object' && 'ok' in payload) {
              throw {
                code: (payload.error && payload.error.code) || 'HTTP_ERROR',
                message: (payload.error && payload.error.message) || ('HTTP ' + response.status),
                correlationId: (payload.meta && payload.meta.correlationId) || null,
                raw: payload
              };
            }

            throw {
              code: 'HTTP_ERROR',
              message: 'HTTP ' + response.status,
              correlationId: null,
              raw: payload
            };
          }

          if (payload && typeof payload === 'object' && 'ok' in payload) {
            if (!payload.ok) {
              throw {
                code: (payload.error && payload.error.code) || 'ENVELOPE_ERROR',
                message: (payload.error && payload.error.message) || 'An error occurred.',
                correlationId: (payload.meta && payload.meta.correlationId) || null,
                raw: payload
              };
            }

            return payload;
          }

          return {
            ok: true,
            data: payload,
            error: null,
            meta: { correlationId: null }
          };
        });
      });
  }

  function normalizeError(err) {
    if (!err) {
      return { code: 'UNKNOWN_ERROR', message: 'An error occurred.' };
    }

    if (err.code) {
      return { code: err.code, message: err.message || 'An error occurred.' };
    }

    if (err.error && err.error.code) {
      return { code: err.error.code, message: err.error.message || 'An error occurred.' };
    }

    return { code: 'UNKNOWN_ERROR', message: err.message || 'An error occurred.' };
  }

  function messageForCode(code) {
    switch (code) {
      case 'AUTH_LOGIN_REQUIRED':
      case 'AUTH_REQUIRED':
        return 'Please log in to continue.';
      case 'REVIEW_NOT_ELIGIBLE':
      case 'NOT_ELIGIBLE':
        return 'Paid purchases only.';
      case 'REVIEW_DUPLICATE':
      case 'DUPLICATE':
        return 'Already submitted for this order.';
      case 'REVIEW_CONFLICT':
        return 'Please retry.';
      case 'REVIEW_INVALID_INPUT':
      case 'INVALID_INPUT':
        return 'Please check your input.';
      case 'REVIEW_RATE_LIMITED':
      case 'RATE_LIMITED':
        return 'Please retry in a moment.';
      case 'REVIEW_SHOPIFY_API_ERROR':
      case 'SHOPIFY_API_ERROR':
      case 'SHOPIFY_ADMIN_API_ERROR':
        return 'Temporary error. Try later.';
      case 'TIMEOUT':
        return 'Request timed out. Try again.';
      case 'NETWORK_ERROR':
        return 'Network error. Please try again.';
      case 'PARSE_ERROR':
        return 'Temporary error. Try later.';
      default:
        return 'Temporary error. Try later.';
    }
  }

  function setStatus(form, message, tone) {
    var status = form.querySelector('[data-review-status]');
    if (!status) {
      return;
    }
    status.textContent = message || '';
    status.classList.remove('is-error', 'is-success');
    if (tone === 'error') {
      status.classList.add('is-error');
    }
    if (tone === 'success') {
      status.classList.add('is-success');
    }
  }

  function setSubmitting(form, isSubmitting) {
    var button = form.querySelector('[data-review-submit]');
    if (!button) {
      return;
    }

    if (!button.getAttribute('data-label')) {
      button.setAttribute('data-label', button.textContent || 'Submit');
    }

    if (isSubmitting) {
      button.disabled = true;
      button.textContent = 'Submitting...';
      form.setAttribute('aria-busy', 'true');
    } else {
      var isLocked = form.getAttribute('data-review-locked') === 'true';
      if (!isLocked) {
        button.disabled = false;
        button.textContent = button.getAttribute('data-label') || 'Submit';
      }
      form.removeAttribute('aria-busy');
    }
  }

  function lockForm(form, label) {
    form.setAttribute('data-review-locked', 'true');
    var textarea = form.querySelector('[data-review-body]');
    var button = form.querySelector('[data-review-submit]');
    if (textarea) {
      textarea.disabled = true;
    }
    if (button) {
      button.disabled = true;
      button.textContent = label || 'Submitted';
    }
  }

  function formatDate(dateValue) {
    if (!dateValue) {
      return '';
    }

    var date = new Date(dateValue);
    if (isNaN(date.getTime())) {
      return '';
    }

    return date.toLocaleString();
  }

  function showSubmittedReview(target, body, submittedAt, review) {
    var wrapper = document.createElement('div');
    wrapper.className = 'ob-review ob-review--submitted';
    var orderId = target.getAttribute('data-order-id') || (review && review.orderId) || '';
    if (orderId) {
      wrapper.setAttribute('data-order-id', orderId);
    }
    if (review && review.id) {
      wrapper.setAttribute('data-review-id', review.id);
      wrapper.setAttribute('data-review-body-value', body);
      if (submittedAt) {
        wrapper.setAttribute('data-review-submitted-at', submittedAt);
      }
    }

    var status = document.createElement('p');
    status.className = 'ob-status is-success';
    status.textContent = 'Review submitted.';
    wrapper.appendChild(status);

    if (submittedAt) {
      var meta = document.createElement('p');
      meta.className = 'ob-status';
      meta.textContent = 'Submitted at: ' + submittedAt;
      wrapper.appendChild(meta);
    }

    var content = document.createElement('p');
    content.className = 'ob-review__body';
    content.textContent = body;
    wrapper.appendChild(content);

    if (review && review.id) {
      var actions = document.createElement('div');
      actions.className = 'ob-review__actions';

      var editButton = document.createElement('button');
      editButton.type = 'button';
      editButton.className = 'ob-btn--secondary';
      editButton.setAttribute('data-review-edit', '');
      editButton.textContent = 'Edit review';
      actions.appendChild(editButton);

      var deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'ob-btn--text';
      deleteButton.setAttribute('data-review-delete', '');
      deleteButton.textContent = 'Delete review';
      actions.appendChild(deleteButton);
      wrapper.appendChild(actions);
    }

    target.replaceWith(wrapper);
  }

  function showReadOnlyReview(form, review) {
    if (!review || typeof review !== 'object') {
      lockForm(form, 'Submitted');
      return;
    }

    var body = (review.body || '').trim();
    if (!body) {
      lockForm(form, 'Submitted');
      return;
    }

    showSubmittedReview(form, body, formatDate(review.submittedAt), review);
  }

  function showEditReview(wrapper) {
    var body = wrapper.getAttribute('data-review-body-value') || '';
    var reviewId = wrapper.getAttribute('data-review-id') || '';
    var orderId = wrapper.getAttribute('data-order-id') || '';
    if (!reviewId || !orderId) {
      return;
    }

    wrapper.textContent = '';
    wrapper.classList.remove('ob-review--submitted');
    wrapper.classList.add('ob-review--editing');

    var status = document.createElement('p');
    status.className = 'ob-status';
    status.setAttribute('data-review-status', '');
    status.setAttribute('aria-live', 'polite');
    wrapper.appendChild(status);

    var textarea = document.createElement('textarea');
    textarea.className = 'ob-textarea';
    textarea.setAttribute('data-review-edit-body', '');
    textarea.minLength = MIN_LEN;
    textarea.maxLength = MAX_LEN;
    textarea.value = body;
    wrapper.appendChild(textarea);

    var count = document.createElement('span');
    count.className = 'ob-review-count';
    count.setAttribute('data-review-edit-count', '');
    count.style.cssText = 'font-size:12px;color:var(--muted);';
    count.textContent = body.trim().length + ' / ' + MAX_LEN;
    wrapper.appendChild(count);

    var actions = document.createElement('div');
    actions.className = 'ob-review__actions';
    var saveButton = document.createElement('button');
    saveButton.type = 'button';
    saveButton.className = 'ob-btn--primary';
    saveButton.setAttribute('data-review-save', '');
    saveButton.textContent = 'Save changes';
    actions.appendChild(saveButton);

    var cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'ob-btn--secondary';
    cancelButton.setAttribute('data-review-cancel', '');
    cancelButton.textContent = 'Cancel';
    actions.appendChild(cancelButton);
    wrapper.appendChild(actions);

    wrapper.setAttribute('data-review-body-value', body);
    textarea.focus();
  }

  function saveEditedReview(wrapper) {
    var reviewId = wrapper.getAttribute('data-review-id') || '';
    var orderId = wrapper.getAttribute('data-order-id') || '';
    var textarea = wrapper.querySelector('[data-review-edit-body]');
    var saveButton = wrapper.querySelector('[data-review-save]');
    if (!reviewId || !orderId || !textarea) {
      return;
    }
    var body = textarea.value.trim();
    if (body.length < MIN_LEN || body.length > MAX_LEN) {
      setStatus(wrapper, 'Please check your input.', 'error');
      return;
    }
    if (saveButton) {
      saveButton.disabled = true;
      saveButton.textContent = 'Saving...';
    }
    setStatus(wrapper, 'Saving...', null);

    fetchEnvelope(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'update', reviewId: reviewId, orderId: orderId, body: body })
    })
      .then(function(payload) {
        var item = payload && payload.data && payload.data.item ? payload.data.item : null;
        showSubmittedReview(wrapper, item && item.body ? item.body : body, formatDate(item && item.submittedAt), item || { id: reviewId, orderId: orderId });
      })
      .catch(function(error) {
        var normalized = normalizeError(error);
        setStatus(wrapper, messageForCode(normalized.code), 'error');
        if (saveButton) {
          saveButton.disabled = false;
          saveButton.textContent = 'Save changes';
        }
      });
  }

  function deleteReview(wrapper) {
    var reviewId = wrapper.getAttribute('data-review-id') || '';
    var orderId = wrapper.getAttribute('data-order-id') || '';
    if (!reviewId || !orderId || !window.confirm('Delete this review?')) {
      return;
    }
    var deleteButton = wrapper.querySelector('[data-review-delete]');
    if (deleteButton) {
      deleteButton.disabled = true;
      deleteButton.textContent = 'Deleting...';
    }
    fetchEnvelope(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', reviewId: reviewId, orderId: orderId })
    })
      .then(function() {
        window.location.reload();
      })
      .catch(function(error) {
        var normalized = normalizeError(error);
        var status = wrapper.querySelector('[data-review-status]');
        if (status) {
          status.textContent = messageForCode(normalized.code);
          status.classList.add('is-error');
        }
        if (deleteButton) {
          deleteButton.disabled = false;
          deleteButton.textContent = 'Delete review';
        }
      });
  }

  function normalizeOrderKey(value) {
    var orderId = (value || '').toString().trim();
    if (!orderId) {
      return '';
    }

    if (orderId.indexOf('gid://shopify/Order/') === 0) {
      return orderId.replace('gid://shopify/Order/', '');
    }

    return orderId;
  }

  function buildOrderStatusMap(items) {
    var map = {};
    if (!Array.isArray(items)) {
      return map;
    }

    items.forEach(function(item) {
      if (!item || typeof item !== 'object') {
        return;
      }
      var rawOrderId = item.orderId ? String(item.orderId) : '';
      var normalized = normalizeOrderKey(rawOrderId);

      if (rawOrderId) {
        map[rawOrderId] = item;
      }
      if (normalized) {
        map[normalized] = item;
      }
      if (normalized) {
        map['gid://shopify/Order/' + normalized] = item;
      }
    });

    return map;
  }

  function loadExistingReviewStatus() {
    var forms = Array.prototype.slice.call(root.querySelectorAll('[data-review-form]'));
    if (!forms.length) {
      return Promise.resolve();
    }

    var orderIds = [];
    forms.forEach(function(form) {
      var orderId = form.getAttribute('data-order-id');
      if (!orderId) {
        return;
      }
      if (orderIds.indexOf(orderId) === -1) {
        orderIds.push(orderId);
      }
    });

    if (!orderIds.length) {
      return Promise.resolve();
    }

    var params = new URLSearchParams({
      orderIds: orderIds.join(',')
    });

    var requestPath = ORDER_STATUS_ENDPOINT + '?' + params.toString();
    var fallbackPath = ORDER_STATUS_ENDPOINT_FALLBACK + '?' + params.toString();

    return fetchEnvelope(requestPath, { method: 'GET' })
      .catch(function() {
        return fetchEnvelope(fallbackPath, { method: 'GET' });
      })
      .then(function(payload) {
        var items = payload && payload.data && Array.isArray(payload.data.items)
          ? payload.data.items
          : [];
        var statusMap = buildOrderStatusMap(items);

        forms.forEach(function(form) {
          var orderId = form.getAttribute('data-order-id');
          if (!orderId) {
            return;
          }
          var key = normalizeOrderKey(orderId);
          var statusItem = statusMap[orderId] || statusMap[key] || statusMap['gid://shopify/Order/' + key];
          if (!statusItem || statusItem.reviewed !== true) {
            return;
          }

          showReadOnlyReview(form, statusItem.review);
        });
      })
      .catch(function() {
        return null;
      });
  }

  function updateCount(textarea) {
    if (!textarea) {
      return;
    }
    var form = textarea.closest('[data-review-form], .ob-review--editing');
    if (!form) {
      return;
    }
    var count = form.querySelector('[data-review-count], [data-review-edit-count]');
    if (!count) {
      return;
    }
    var length = textarea.value.trim().length;
    count.textContent = length + ' / ' + MAX_LEN;
  }

  function handleInput(event) {
    if (!event.target.matches('[data-review-body], [data-review-edit-body]')) {
      return;
    }
    updateCount(event.target);
  }

  function handleReviewAction(event) {
    var button = event.target.closest('[data-review-edit], [data-review-save], [data-review-cancel], [data-review-delete]');
    if (!button) {
      return;
    }
    var wrapper = button.closest('.ob-review');
    if (!wrapper) {
      return;
    }
    if (button.matches('[data-review-edit]')) {
      showEditReview(wrapper);
      return;
    }
    if (button.matches('[data-review-save]')) {
      saveEditedReview(wrapper);
      return;
    }
    if (button.matches('[data-review-cancel]')) {
      showSubmittedReview(
        wrapper,
        wrapper.getAttribute('data-review-body-value') || '',
        wrapper.getAttribute('data-review-submitted-at') || '',
        {
          id: wrapper.getAttribute('data-review-id') || '',
          orderId: wrapper.getAttribute('data-order-id') || ''
        }
      );
      return;
    }
    if (button.matches('[data-review-delete]')) {
      deleteReview(wrapper);
    }
  }

  function handleSubmit(event) {
    var form = event.target.closest('[data-review-form]');
    if (!form) {
      return;
    }
    event.preventDefault();

    if (form.getAttribute('data-review-locked') === 'true') {
      return;
    }

    var textarea = form.querySelector('[data-review-body]');
    if (!textarea) {
      return;
    }

    var body = textarea.value.trim();
    if (body.length < MIN_LEN || body.length > MAX_LEN) {
      setStatus(form, 'Please check your input.', 'error');
      return;
    }

    var orderId = form.getAttribute('data-order-id');
    var productId = form.getAttribute('data-product-id');

    if (!orderId || !productId) {
      setStatus(form, 'This order cannot be reviewed.', 'error');
      return;
    }

    setSubmitting(form, true);
    setStatus(form, 'Submitting...', null);

    fetchEnvelope(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        reviewType: 'customer',
        productId: productId,
        orderId: orderId,
        body: body
      })
    })
      .then(function(payload) {
        var item = payload && payload.data ? payload.data : null;
        showSubmittedReview(
          form,
          item && item.body ? item.body : body,
          formatDate(item && item.submittedAt) || formatDate(new Date().toISOString()),
          item
        );
      })
      .catch(function(error) {
        var normalized = normalizeError(error);
        var message = messageForCode(normalized.code);
        setStatus(form, message, 'error');
        if (normalized.code === 'REVIEW_DUPLICATE' || normalized.code === 'DUPLICATE') {
          lockForm(form, 'Submitted');
        }
      })
      .finally(function() {
        setSubmitting(form, false);
      });
  }

  root.addEventListener('input', handleInput);
  root.addEventListener('submit', handleSubmit);
  root.addEventListener('click', handleReviewAction);

  var textareas = Array.prototype.slice.call(root.querySelectorAll('[data-review-body]'));
  textareas.forEach(function(textarea) {
    updateCount(textarea);
  });

  if (root.querySelector('[data-review-form]')) {
    setReviewLoading(true);
    loadExistingReviewStatus()
      .then(function() {
        setReviewLoading(false);
      });
  } else {
    setReviewLoading(false);
  }
})();
