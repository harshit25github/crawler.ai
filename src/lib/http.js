export async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }
  }

  if (!response.ok) {
    const message =
      data?.status?.error ||
      data?.message ||
      data?.error ||
      `HTTP ${response.status} for ${url}`;

    const error = new Error(message);
    error.statusCode = response.status;
    error.body = data;
    throw error;
  }

  return data;
}

export async function getJson(url, headers = {}) {
  return requestJson(url, {
    method: "GET",
    headers,
  });
}

export async function postJson(url, body, headers = {}) {
  return requestJson(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

export async function putJson(url, body, headers = {}) {
  return requestJson(url, {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
}
