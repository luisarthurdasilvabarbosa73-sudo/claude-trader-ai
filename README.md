# CLAUDE TRADER AI

Robô autônomo de day trade para **Binance Spot** (sem alavancagem), com painel PWA em português
instalável no Android, execução contínua na nuvem e gestão de risco rígida.

> **Estado atual: ETAPAS 2–7 construídas. Opera SOMENTE em SIMULAÇÃO (paper trading)**, com dados
> reais de mercado e R$30 fictícios. Testnet e conta real estão **bloqueadas no código**.
> Nenhum resultado aqui é promessa de lucro.

## O que já funciona

| Módulo | Situação |
|---|---|
| Backend Python + FastAPI (API autenticada, serve o app) | ✅ pronto (rotas testadas via camada de serviço; teste FastAPI roda no CI) |
| Banco SQLite (ordens, posições, decisões, eventos, patrimônio, IA) | ✅ pronto e testado |
| Conexão Binance: REST oficial, filtros reais, WebSocket com reconexão, fallback REST | ✅ pronto; testado com respostas simuladas (sem internet no ambiente de construção) |
| Motor de análise: RSI, MACD, EMA 9/21/50/200, VWAP, Bollinger, ATR, volume, S/R, price action | ✅ pronto e testado (RSI confere com a referência clássica de Wilder) |
| Estratégia multi-timeframe (1m/5m/15m/1h) com filtros + pontuação 0–100 | ✅ pronta — regras em [docs/ESTRATEGIA.md](docs/ESTRATEGIA.md) |
| Gestão de risco e capital (R$30, taxas, spread, filtros, poeira) | ✅ pronta e testada — [docs/RISCO_E_CAPITAL.md](docs/RISCO_E_CAPITAL.md) |
| Simulador (paper trading) com taxa, spread, slippage e rejeições reais | ✅ pronto e testado |
| Backtest com o mesmo motor + dados reais oficiais | ✅ pronto; **dados reais ainda não rodados** (roda no GitHub Actions) |
| Módulo IA (Claude) — só analisa, nunca altera limites | ✅ pronto, opcional, testado com resposta simulada |
| App PWA (Painel, Cérebro, Gráfico, Histórico, Ajustes) | ✅ pronto; testado no Chrome em tela de celular |
| Notificações | ⚠️ funcionam com o app aberto/recente; push com app fechado fica para depois |
| Modo TESTNET | 🔒 bloqueado — ETAPA 9 |
| Modo REAL | 🔒 bloqueado — ETAPA 10, só com sua autorização explícita |

## Estrutura

```
backend/
  app/
    config.py            variáveis de ambiente e travas de etapa
    domain.py            modelos (candle, posição, execução)
    db.py                banco SQLite
    binance/             REST oficial, filtros, WebSocket, dados de mercado
    analysis/            indicadores, suporte/resistência, padrões, estratégia
    risk/                limites rígidos, capital, gestor de risco
    execution/           paper.py (simulação) | live.py (bloqueado) | factory.py
    engine/              motor autônomo, cérebro, estatísticas
    ai/advisor.py        análise estratégica com Claude (opcional)
    backtest/            backtest com dados reais (data.binance.vision)
    service.py, main.py  API (FastAPI) + segurança
  tests/                 testes automatizados (pytest)
  scripts/backtest.py    backtest pela linha de comando / GitHub Actions
frontend/                app PWA (React + TypeScript + Vite)
docs/                    arquitetura, estratégia, risco, publicação, testes
Dockerfile               imagem única (app + API + robô)
railway.json             configuração de implantação
.github/workflows/       CI: descompacta, testa, compila e faz backtest
```

## Documentação

- [Arquitetura e tecnologias](docs/ARQUITETURA.md)
- [Estratégia (regras completas)](docs/ESTRATEGIA.md)
- [Risco, capital e o problema dos R$30](docs/RISCO_E_CAPITAL.md)
- [Relatório de testes](docs/RELATORIO_DE_TESTES.md)
- [Publicar no GitHub pelo Android](docs/PUBLICAR_PELO_ANDROID.md)

## Segurança, em resumo

- Chaves da Binance só no servidor (variáveis protegidas). O app nunca as recebe.
- A simulação não usa chave nenhuma (só dados públicos).
- Quando houver chave (ETAPA 9+): somente permissão de Spot; o robô **recusa** chaves com saque,
  transferência, margem ou futuros.
- Login com senha, token assinado, bloqueio após 5 erros, cabeçalhos de segurança, tudo registrado.
- Limites de risco têm faixas máximas no código que nem o app nem a IA podem ultrapassar.

## Próximas etapas
1. **Agora:** publicar no GitHub pelo Android ([passo a passo](docs/PUBLICAR_PELO_ANDROID.md)) — o GitHub
   roda os testes que dependem de internet e compila o app oficialmente.
2. **ETAPA 8:** implantar na nuvem (Railway, região Europa), com volume persistente e senha forte; ligar a simulação 24h.
3. Rodar o backtest com dados reais e acompanhar a simulação por alguns dias.
4. **ETAPA 9:** liberar e testar a Testnet da Binance.
5. **ETAPA 10:** somente com sua autorização explícita, preparar a operação real.
