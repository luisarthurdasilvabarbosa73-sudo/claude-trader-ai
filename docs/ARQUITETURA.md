# Arquitetura

```
 Android (Chrome)                         Nuvem (1 contêiner, região fora dos EUA)
 ┌──────────────────┐   HTTPS + token    ┌───────────────────────────────────────────┐
 │ App PWA          │ ─────────────────▶ │ FastAPI  ──  ApiService                    │
 │ Painel / Cérebro │ ◀───────────────── │             │                              │
 │ Gráfico / Ajustes│   JSON (3 s)       │   TradingEngine (loop 1 s, independente)   │
 └──────────────────┘                    │    ├─ Strategy (indicadores + pontuação)   │
                                         │    ├─ RiskManager + capital.py             │
                                         │    ├─ PaperBroker (SIMULAÇÃO)               │
                                         │    │   LiveBroker (TESTNET/REAL 🔒)         │
                                         │    └─ Brain (explicações)                   │
                                         │   BinanceMarketData                         │
                                         │    ├─ REST data-api.binance.vision          │
                                         │    └─ WebSocket data-stream.binance.vision  │
                                         │   SQLite em volume persistente (/data)      │
                                         │   ClaudeAdvisor (opcional, sob demanda)     │
                                         └───────────────────────────────────────────┘
```

## Decisões técnicas

| Tema | Escolha | Motivo |
|---|---|---|
| Linguagem do robô | Python 3.12 | legível, ótimo para cálculo e testes |
| API | FastAPI + Uvicorn | assíncrono, validação de entrada, padrão de mercado |
| Indicadores | implementação própria em Python puro | sem dependências opacas; cada fórmula testada |
| Banco | SQLite (modo WAL) em volume | um único robô não precisa de servidor de banco; zero custo extra |
| Dados de mercado | endpoints oficiais `data-api` / `data-stream` da Binance | domínios oficiais só de dados públicos; não exigem chave |
| App | React + TypeScript + Vite, PWA | instala pelo Chrome, sem loja e sem Termux |
| Gráficos | SVG próprio | sem biblioteca externa; leve no celular |
| Hospedagem (ETAPA 8) | Railway, região **EU West (Amsterdã)** ou **Singapura** | deploy pelo navegador a partir do GitHub, volume persistente, reinício automático |

### Por que não rodar nos EUA
A Binance responde **HTTP 451** para servidores em locais restritos (como os EUA). O sistema detecta isso,
mostra o aviso no app e não opera. Por isso a região do servidor deve ser Europa ou Ásia.

### Custo estimado
O plano Hobby do Railway custa US$5/mês e inclui US$5 de uso (fonte: docs.railway.com/reference/pricing).
Um serviço pequeno sempre ligado normalmente cabe nesse valor, mas **confira no painel**. Atenção: US$5/mês
é praticamente o valor do capital de R$30 — ver [RISCO_E_CAPITAL.md](RISCO_E_CAPITAL.md).

## Separação simulação × execução real
- `execution/paper.py` não importa cliente assinado nem credenciais (há teste que garante isso).
- `execution/live.py` só pode ser instanciado se `TESTNET_RELEASED`/`REAL_RELEASED` forem `True` em
  `config.py` — hoje ambos são `False`. Nenhuma variável de ambiente, rota da API ou resposta da IA muda isso.

## Reinício seguro
Estado do robô, conta simulada, posições abertas, estado de risco e todas as ordens ficam no banco.
Ao reiniciar: restaura tudo, espera dados novos e só retoma se estava RODANDO (`AUTO_RESUME=true`).
EMERGÊNCIA nunca é retomada automaticamente.
