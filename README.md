# Private Vault Web App

Frontend for your COTI contracts:

- `PrivateUSDCe`
- `PrivateCOTI`
- `USDCePrivateVault`
- `COTIPrivateVault`

## Features

- Wallet connect (injected provider / MetaMask)
- COTI Mainnet switch helper
- Contracts are pre-integrated (no manual address input)
- USDC.e flow:
  - `approve`
  - `toPrivate(amount)` with vault fee in COTI
  - `toPublic(amount)` with vault fee in COTI
- COTI flow:
  - `toPrivate(amount)` with `{ value: amount + fee }`
  - `toPublic(amount)` with `{ value: fee }`
- Live snapshot:
  - wallet balances
  - vault reserves
  - allowances
  - private token total supplies

## Run

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
npm run preview
```

## GitHub Pages

- Deploy is automated via `.github/workflows/deploy-pages.yml`.
- Every push to `main` builds and publishes `dist` to GitHub Pages.
- Expected URL: `https://rosulaurentiu.github.io/private-vault-app/`

## Notes

- COTI conversion requires amounts in steps of `0.000001` COTI (`1e12` wei), matching your vault contract constraints.
- Vault fees are read directly from each deployed vault (`swapFeeWei`) and paid automatically by the UI.
- Contract addresses are hardcoded in `src/App.tsx` under `DEPLOYED`.
