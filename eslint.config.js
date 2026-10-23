export default [
    {
        files: ['index.js', 'src/**/*.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: {
                window: 'readonly', document: 'readonly', navigator: 'readonly', location: 'readonly', console: 'readonly',
                fetch: 'readonly', Blob: 'readonly', File: 'readonly', FileReader: 'readonly', FormData: 'readonly',
                URL: 'readonly', URLSearchParams: 'readonly', Image: 'readonly', Node: 'readonly', Notification: 'readonly',
                AbortController: 'readonly', XMLHttpRequest: 'readonly', ReadableStream: 'readonly', setTimeout: 'readonly',
                clearTimeout: 'readonly', setInterval: 'readonly', requestAnimationFrame: 'readonly', performance: 'readonly',
                matchMedia: 'readonly', innerWidth: 'readonly', innerHeight: 'readonly', atob: 'readonly', structuredClone: 'readonly',
                getComputedStyle: 'readonly', prompt: 'readonly', globalThis: 'readonly', SillyTavern: 'readonly', toastr: 'readonly', HTMLInputElement: 'readonly', HTMLSelectElement: 'readonly', HTMLTextAreaElement: 'readonly',
            },
        },
        rules: {
            'no-undef': 'error',
            'no-unused-vars': ['warn', { args: 'none' }],
            'no-unreachable': 'error',
            'no-dupe-keys': 'error',
            'no-redeclare': 'error',
            'prefer-const': 'warn',
            eqeqeq: ['warn', 'smart'],
        },
    },
];
