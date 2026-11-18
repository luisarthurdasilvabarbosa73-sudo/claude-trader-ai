# Relatório de testes

## Atualização (17/11/2026, noite) — robô dentro do app
- **10 testes do motor do app** (TypeScript, `npm test`): RSI de referência, arredondamento de lote,
  limites rígidos, R$30 (poeira e risco), simulador, robô parado não entra, ciclo completo sem
  duplicidade + emergência, dados desatualizados, histórico restaurado ao reabrir.
- **Paridade com o Python:** mesmos dados sintéticos (2 ativos, 1.200 minutos) → **2.400 decisões
  idênticas, 7 operações idênticas e o mesmo patrimônio final** (diferença < 0,000001).
- **Navegador (Chrome, tela de celular, endereço no formato do GitHub Pages):**
  - modo real sem internet → mostra o erro com clareza e não cria saldo sem cotação real;
  - modo demonstração → iniciar, operações simuladas, 5 telas, risco de 50% recusado, emergência,
    histórico mantido após recarregar, service worker ativo.
- Não testado ainda: conexão real com a Binance a partir do celular (o ambiente de construção não
  tem internet) — será confirmada assim que você abrir o app.

## Primeira missão

## Resultado: 97 testes aprovados, 1 pulado, 0 falhas

Executados com `pytest` (Python 3.13) no ambiente de construção. O teste pulado é o das rotas FastAPI
(o FastAPI não estava instalado nesse ambiente) — ele roda automaticamente no GitHub Actions.

| Arquivo | Testes | O que cobre |
|---|---|---|
| test_indicators.py | 13 | EMA/SMA com valores conhecidos; **RSI idêntico à referência clássica de Wilder (70,53 · 66,32 · 66,55 · 69,41 · 66,36 · 57,97)**; MACD; Bollinger; ATR com gaps; VWAP com virada de dia; volume relativo; suporte/resistência; padrões de candle |
| test_filters_capital.py | 13 | leitura real de `exchangeInfo`; arredondamento sempre para baixo; rejeições NOTIONAL/LOT_SIZE; filtro legado MIN_NOTIONAL; tamanho de posição com R$30; recusa quando o mínimo exigiria mais risco; viabilidade da venda no stop; **sem martingale**; limite de exposição; poeira |
| test_risk_paper.py | 14 | limites rígidos; bloqueios (parado, dados velhos, duplicidade, simultâneas); perda diária; perdas seguidas; circuit breaker; pausa por falhas; simulador com spread+slippage+taxas; posição presa abaixo do mínimo; idempotência; persistência; simulador sem credenciais |
| test_strategy.py | 7 | histórico insuficiente; regime de baixa bloqueia; todo sinal de compra respeita todas as regras; spread alto; pontuação mínima; R:R líquido com custos |
| test_engine.py | 21 | conversão R$30 pela cotação real; robô parado não entra; ciclo completo com alvo; stop com gap; break-even e stop móvel; ordens duplicadas; dados desatualizados; emergência; perda diária; **reinício restaura posições**; circuit breaker; venda impossível relatada; tempo máximo; tendência invalidada; decisões registradas; **lucro registrado = variação do patrimônio (com poeira)** |
| test_binance.py | 9 | **assinatura HMAC idêntica ao exemplo oficial da Binance**; cabeçalho da chave; parsing de klines/livro; HTTP 451 (bloqueio geográfico), 429 (limite), 5xx em ordem = status desconhecido; **WebSocket: queda, conexão zumbi, reconexão com backoff e ressincronização**; inicialização com erro 451 e recuperação |
| test_backtest_ai_security.py | 12 | backtest com custos e métricas consistentes; exige cotação real; **stop e alvo no mesmo minuto → assume o stop**; CSV com microssegundos; IA desativada sem chave; IA limitada e **incapaz de alterar configurações**; relatório sem segredos; token; força bruta; segredos fortes em produção; dados sintéticos proibidos em produção; **REAL/TESTNET travados mesmo com variáveis de ambiente** |
| test_service_api.py | 9 | login; bloqueio após 5 erros; bloqueio global mesmo trocando de IP; painel; gráfico; iniciar/pausar/emergência; limites de risco pela API; recusa do modo REAL; reset da simulação; rotas FastAPI (no CI) |

## Teste de ponta a ponta no navegador
App compilado e aberto no Chrome em tela de celular (412×915), contra o servidor com dados **sintéticos**
(sem internet no ambiente de construção). Verificado: login errado é recusado; login certo; iniciar o
robô; robô abriu e fechou operações simuladas; as 5 abas renderizam; tentativa de risco de 50% recusada
com mensagem; emergência com confirmação "PARAR"; service worker registrado; manifesto PWA válido.
Também conferido: patrimônio = capital inicial + soma dos resultados (diferença de 0,002 USDT = poeira reavaliada).

## Problemas encontrados e corrigidos durante a construção
1. **Senha do administrador aparecia na representação interna das configurações** — corrigido (teste garante).
2. **Poeira não vendável**: compras de ~6 USDT de BTC deixavam a posição abaixo do mínimo de venda.
   Implementados: checagem da venda no stop, limite de valor do lote, reaproveitamento da poeira e
   contabilização no resultado.
3. Proteção de login confiava no 1º IP do cabeçalho X-Forwarded-For (falsificável) — agora usa o IP
   adicionado pelo proxy e há um bloqueio global após 20 erros.
4. Rotas da API rodando em threads paralelas ao motor (risco de leitura concorrente) — rotas agora
   rodam no mesmo laço do motor; só a chamada à IA roda em paralelo.
5. Tipos do TypeScript (lib WebWorker conflitando com DOM) — corrigido.

## O que NÃO foi testado ainda (honestamente)
- Conexão real com a Binance (o ambiente de construção não tinha acesso à internet).
- Backtest com dados históricos reais — pronto para rodar no GitHub Actions.
- Compilação oficial com Vite e verificação de tipos completa com `@types/react` — roda no GitHub Actions.
- Implantação na nuvem e funcionamento 24h — ETAPA 8.
- Falhas reais de servidor/reinício na nuvem — ETAPA 8.
