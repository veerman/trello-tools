// Shared by the board editor and the member manager: the API key, one stored login, one API helper,
// and the Connect dialog. Everything runs in the browser, so the pages can be hosted as plain files.

// Whoever hosts these pages can put their Trello API key here so visitors only have to approve.
// Leave it empty and everyone brings their own key in the Connect dialog.
const DEFAULT_TRELLO_API_KEY = '';
const TRELLO_APP_NAME = 'Trello Tools';
const TOKEN_STORAGE_KEY = 'trello_tools_token';
const API_KEY_STORAGE_KEY = 'trello_tools_api_key';
// Each page used to keep its own token under one of these
const OLD_TOKEN_KEYS = ['trello_oauth_token', 'trello_global_token', 'trello_org_token'];

// Text from Trello (names, card titles, errors) is escaped before it goes into innerHTML
const escapeHtml = (text) => String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

let trelloRequestCount = 0;

const trello = {
    // Called while a page waits out the rate limit, with the pause in seconds
    onPause: null,

    // Picks up the token Trello sends back after Connect, then returns the stored token
    // ('' when there is no token or no API key to use it with)
    init() {
        OLD_TOKEN_KEYS.forEach(key => localStorage.removeItem(key));
        const hash = window.location.hash;
        if (hash.startsWith('#token=')) {
            localStorage.setItem(TOKEN_STORAGE_KEY, hash.substring('#token='.length));
            history.replaceState(null, '', window.location.pathname + window.location.search);
        }
        return this.apiKey() ? this.token() : '';
    },

    token() {
        return localStorage.getItem(TOKEN_STORAGE_KEY) || '';
    },

    // The key this browser saved, else the host's default
    apiKey() {
        return localStorage.getItem(API_KEY_STORAGE_KEY) || DEFAULT_TRELLO_API_KEY;
    },

    isValidKey(key) {
        return /^[0-9a-f]{32}$/i.test(key);
    },

    authorizeUrl(key, returnHere = true) {
        const returnUrl = returnHere ? `&return_url=${encodeURIComponent(window.location.href.split('#')[0])}` : '';
        return `https://trello.com/1/authorize?expiration=never&name=${encodeURIComponent(TRELLO_APP_NAME)}&scope=read,write,account&response_type=token&key=${key}${returnUrl}`;
    },

    // Saves the key and sends you to Trello to approve; Trello comes back here with #token=
    authorize(key) {
        localStorage.setItem(API_KEY_STORAGE_KEY, key);
        window.location.href = this.authorizeUrl(key);
    },

    // For when Trello can't send you back here: the token is copied from Trello's page instead
    useToken(key, token) {
        localStorage.setItem(API_KEY_STORAGE_KEY, key);
        localStorage.setItem(TOKEN_STORAGE_KEY, token);
        window.location.reload();
    },

    forgetKey() {
        localStorage.removeItem(API_KEY_STORAGE_KEY);
        localStorage.removeItem(TOKEN_STORAGE_KEY);
    },

    connect() {
        this.showConnectDialog();
    },

    // Also revokes the token at Trello, so a copy left anywhere stops working.
    // The API key stays saved so connecting again is one click.
    async disconnect() {
        const token = this.token();
        localStorage.removeItem(TOKEN_STORAGE_KEY);
        if (token && this.apiKey()) {
            try {
                await window.fetch(`https://api.trello.com/1/tokens/${token}?key=${this.apiKey()}&token=${token}`, { method: 'DELETE' });
            } catch (e) {
                console.warn('could not revoke the token at Trello', e);
            }
        }
        window.location.reload();
    },

    // Every API call goes through here. Pauses every 80 requests to stay under Trello's rate limit.
    async fetch(endpoint, options = {}) {
        trelloRequestCount++;
        if (trelloRequestCount % 80 === 0) {
            if (this.onPause) this.onPause(10);
            await new Promise(resolve => setTimeout(resolve, 10000));
        }

        const separator = endpoint.includes('?') ? '&' : '?';
        const url = `https://api.trello.com/1/${endpoint}${separator}key=${this.apiKey()}&token=${this.token()}`;
        const fetchOptions = { ...options };
        if (options.body) fetchOptions.headers = { 'Content-Type': 'application/json', ...options.headers };

        const response = await window.fetch(url, fetchOptions);
        if (!response.ok) {
            const errorText = await response.text();
            // A revoked or expired login: forget it so the page offers Connect again
            if (response.status === 401 && /invalid token/i.test(errorText)) localStorage.removeItem(TOKEN_STORAGE_KEY);
            throw new Error(`api error ${response.status}: ${errorText}`);
        }
        return response.json();
    },

    showConnectDialog() {
        let dialog = document.getElementById('trello-connect-dialog');
        if (!dialog) {
            dialog = document.createElement('div');
            dialog.id = 'trello-connect-dialog';
            dialog.className = 'hidden fixed inset-0 bg-black/70 z-[10001] flex items-center justify-center p-4 backdrop-blur-sm';
            dialog.innerHTML = `
                <div class="bg-gray-800 rounded-xl max-w-lg w-full border border-gray-600 shadow-2xl p-6 space-y-4 text-sm text-gray-300">
                    <div class="flex justify-between items-center">
                        <h2 class="text-lg font-bold text-white">Connect to Trello</h2>
                        <button data-action="close" class="text-gray-400 hover:text-white bg-gray-700 hover:bg-gray-600 rounded-full w-8 h-8">&times;</button>
                    </div>
                    <p>These pages run in your browser and talk to Trello directly. Your API key and login are kept only in this browser.</p>
                    <label class="block space-y-1">
                        <span class="text-xs font-semibold text-gray-400 uppercase tracking-wide">Your Trello API key</span>
                        <input data-field="key" type="text" spellcheck="false" placeholder="32 letters and numbers" class="w-full bg-gray-700 border border-gray-600 text-white rounded p-2 font-mono text-sm focus:ring-1 focus:ring-blue-500 focus:outline-none">
                    </label>
                    <details class="text-xs text-gray-400">
                        <summary class="cursor-pointer text-blue-400">How to get a key</summary>
                        <ol class="list-decimal ml-5 mt-2 space-y-1">
                            <li>Open <a href="https://trello.com/power-ups/admin" target="_blank" class="text-blue-400 underline">trello.com/power-ups/admin</a> and create a Power-Up. Any name works; it only holds the key.</li>
                            <li>Open its <b>API key</b> page, generate a key, and paste it above.</li>
                            <li>On the same page, add <code data-field="origin" class="bg-gray-700 px-1 rounded"></code> to <b>Allowed origins</b>, so Trello can send you back here after you approve.</li>
                        </ol>
                    </details>
                    <button data-action="connect" class="w-full py-2 rounded font-medium text-white bg-blue-600 hover:bg-blue-500">Connect</button>
                    <details class="text-xs text-gray-400">
                        <summary class="cursor-pointer text-blue-400">Connect doesn't come back here? Paste a token instead</summary>
                        <p class="mt-2">Open <a data-action="token-page" href="#" target="_blank" class="text-blue-400 underline">Trello's approval page</a>, click Allow, and copy the token it shows.</p>
                        <div class="flex gap-2 mt-2">
                            <input data-field="token" type="text" spellcheck="false" placeholder="token" class="flex-1 bg-gray-700 border border-gray-600 text-white rounded p-2 font-mono text-xs focus:ring-1 focus:ring-blue-500 focus:outline-none">
                            <button data-action="use-token" class="px-3 rounded text-white bg-gray-600 hover:bg-gray-500">Use token</button>
                        </div>
                    </details>
                    <p data-field="error" class="hidden text-red-400 text-xs"></p>
                    <button data-action="forget" class="hidden text-xs text-gray-500 hover:text-gray-300 underline">Forget the saved key</button>
                </div>
            `;
            document.body.appendChild(dialog);

            const field = (name) => dialog.querySelector(`[data-field="${name}"]`);
            const action = (name) => dialog.querySelector(`[data-action="${name}"]`);
            const keyOrError = () => {
                const key = field('key').value.trim();
                if (this.isValidKey(key)) return key;
                field('error').textContent = "That doesn't look like a Trello API key. It should be 32 letters and numbers.";
                field('error').classList.remove('hidden');
                return null;
            };

            action('close').addEventListener('click', () => dialog.classList.add('hidden'));
            action('connect').addEventListener('click', () => {
                const key = keyOrError();
                if (key) this.authorize(key);
            });
            action('token-page').addEventListener('click', (e) => {
                const key = keyOrError();
                if (key) e.currentTarget.href = this.authorizeUrl(key, false);
                else e.preventDefault();
            });
            action('use-token').addEventListener('click', () => {
                const key = keyOrError();
                const token = field('token').value.trim();
                if (key && token) this.useToken(key, token);
            });
            action('forget').addEventListener('click', () => {
                this.forgetKey();
                field('key').value = DEFAULT_TRELLO_API_KEY;
                action('forget').classList.add('hidden');
            });
        }

        dialog.querySelector('[data-field="key"]').value = this.apiKey();
        // A page opened from a file has no web address for Trello to return to
        dialog.querySelector('[data-field="origin"]').textContent = window.location.protocol === 'file:'
            ? "this page's web address (a page opened from a file has none: paste a token instead)"
            : window.location.origin;
        dialog.querySelector('[data-field="error"]').classList.add('hidden');
        dialog.querySelector('[data-action="forget"]').classList.toggle('hidden', !localStorage.getItem(API_KEY_STORAGE_KEY));
        dialog.classList.remove('hidden');
    }
};
