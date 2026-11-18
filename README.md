# CLAUDE TRADER AI

Robô de day trade para **Binance Spot** (sem alavancagem) que **roda dentro do próprio app no celular**:
sem servidor e sem mensalidade. Ele analisa o mercado e opera **enquanto o app está aberto na tela**.

> **Estado atual: SOMENTE SIMULAÇÃO (paper trading)** — dados reais da Binance, R$30 fictícios.
> Testnet e conta real estão bloqueadas. Nenhum resultado aqui é promessa de lucro.

## Como funciona
```
 Celular (Chrome / app instalado)
 ┌──────────────────────────────────────────────────────────┐
 │ Telas: Painel · Cérebro · Gráfico · Histórico · Ajustes   │
 │        │                                                  │
 │ Robô (src/core): estratégia + risco + simulação           │
 │        │                     │                            │
 │ Histórico salvo no aparelho  Binance (dados públicos):    │
 │ (localStorage)               REST + WebSocket em tempo real│
 └──────────────────────────────────────────────────────────┘
 GitHub: guarda o código, roda os testes e publica o app (GitHub Pages)
```

## O que já funciona
| Parte | Situação |
|---|---|
| Indicadores: RSI, MACD, EMA 9/21/50/200, VWAP, Bollinger, ATR, volume, S/R, price action | ✅ |
| Estratégia multi-timeframe (1m/5m/15m/1h) com filtros + pontuação | ✅ [regras](docs/ESTRATEGIA.md) |
| Gestão de risco e capital (R$30, taxas, spread, filtros reais, poeira) | ✅ [detalhes](docs/RISCO_E_CAPITAL.md) |
| Simulação com taxa, spread, slippage e rejeições iguais às da Binance | ✅ |
| Dados ao vivo da Binance com reconexão automática e plano B (API WebSocket) | ✅ (testado sem internet; conexão real será confirmada no seu celular) |
| App instalável em português, tela sempre ligada enquanto opera | ✅ |
| Motor do app idêntico ao motor Python de referência (teste de paridade) | ✅ |
| Backtest com dados históricos reais | ✅ pronto (roda no GitHub Actions) |
| IA (Claude) opcional — só analisa, nunca altera limites | ✅ (chave salva só no aparelho) |
| Testnet / Real | 🔒 bloqueados |

## Estrutura
```
frontend/            o app (React + TypeScript)
  src/core/          o robô que roda no celular (estratégia, risco, simulação, dados)
  src/core/tests/    testes do robô + paridade com o Python
backend/             motor de referência em Python + backtest + testes (servidor opcional p/ o futuro)
docs/                estratégia, risco, arquitetura, testes, instalação
.github/workflows/   testes automáticos, publicação do app e backtest
```

## Documentação
- [Instalar no celular](docs/INSTALAR_NO_CELULAR.md)
- [Estratégia (regras completas)](docs/ESTRATEGIA.md)
- [Risco, capital e o problema dos R$30](docs/RISCO_E_CAPITAL.md)
- [Arquitetura](docs/ARQUITETURA.md)
- [Relatório de testes](docs/RELATORIO_DE_TESTES.md)

## Limites honestos
- Fechou o app (ou a tela apagou por muito tempo), o robô para. Ao reabrir, posições abertas são
  retomadas e avaliadas pelo preço atual — o que pode ser pior que o stop.
- Para **dinheiro real** no futuro, a chave da Binance não pode ficar no celular (regra de segurança
  do projeto). Isso exigirá um servidor ou ordens de proteção registradas na própria Binance — decisão da ETAPA 10.
