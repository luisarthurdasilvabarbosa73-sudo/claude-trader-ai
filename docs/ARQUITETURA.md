# Arquitetura

## Decisão: o robô roda no celular (sem servidor)
O proprietário escolheu não usar servidor nem pagar hospedagem e acompanhar o robô enquanto ele roda.
Por isso o motor (estratégia, risco, simulação e conexão com a Binance) roda **dentro do app**, no Chrome
do Android. O app é publicado de graça no GitHub Pages e instalado na tela inicial (PWA).

```
 Celular                                         Binance (endpoints oficiais de dados públicos)
 ┌──────────────────────────────────────────┐   REST data-api.binance.vision (+ api.binance.com)
 │ Telas React ─▶ runtime.ts (rotas locais)  │◀▶ WebSocket data-stream.binance.vision (tempo real)
 │                 └▶ TradingEngine (1 s)    │   Plano B: API WebSocket ws-api.binance.com
 │                     ├ Strategy (score)    │
 │                     ├ RiskManager/capital │   GitHub Actions: testes Python + testes do app
 │                     ├ PaperBroker         │   + PARIDADE (app decide igual ao Python) + Pages
 │                     └ Brain (explicações) │
 │ localStorage: ordens, posições, decisões  │
 └──────────────────────────────────────────┘
```

| Tema | Escolha | Motivo |
|---|---|---|
| Robô ao vivo | TypeScript em `frontend/src/core` | roda no navegador do celular, sem instalar nada |
| Referência e backtest | Python em `backend/` | testado (97 testes) e usado para backtest com dados reais |
| Garantia de que os dois são iguais | teste de **paridade** no CI | mesmos dados → mesmas 2.400 decisões e mesmas operações |
| Armazenamento | localStorage do aparelho, com limites de tamanho | sem servidor; histórico sobrevive a fechar o app |
| App | React + TypeScript + Vite, PWA | instala pela tela inicial, abre em tela cheia |
| Publicação | GitHub Pages | grátis, HTTPS, atualiza a cada envio ao GitHub |
| Segurança do app | Content-Security-Policy restrita (só Binance e API do Claude) | reduz risco de código malicioso |

## Consequências (honestas)
- O robô só funciona com o app aberto na tela (a tela fica ligada automaticamente enquanto opera).
- Se o app ficar fechado com posição aberta, ela só é reavaliada ao reabrir, pelo preço daquele momento.
- **Dinheiro real** exigirá revisar esta arquitetura: a regra do projeto proíbe guardar a chave da
  Binance no aparelho. O `backend/` (FastAPI) continua no repositório como base para um servidor futuro.

## Separação simulação × Testnet × real
- `paper.ts`: simulação, não envia nada a lugar nenhum.
- `testnet.ts` + `signed.ts`: ordens assinadas (HMAC-SHA256 via Web Crypto) pela API WebSocket da
  **Testnet** (`wss://ws-api.testnet.binance.vision`). O endereço é fixo no código.
- **Não existe código de negociação na conta real.** A chave da Testnet fica só no aparelho.
No `backend/`, `execution/live.py` continua travado por `TESTNET_RELEASED`/`REAL_RELEASED = False`.
