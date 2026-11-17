# Estratégia: Pullback de Tendência Multi-Timeframe (v1.0)

Somente **compra** (Binance Spot não permite vender o que você não tem). Movimentos de baixa são usados
para **ficar de fora** e para **sair** de posições.

Avaliação: a cada candle de 1 minuto **fechado** (sem "repintura"), para cada ativo.
Execução: a mercado, pagando o preço de venda (ask) — o spread real é sempre pago.

## 1. Filtros obrigatórios (todos precisam passar)

| # | Filtro | Regra |
|---|---|---|
| 1 | Histórico suficiente | 1m ≥ 60, 5m ≥ 60, 15m ≥ 60, 1h ≥ 210 candles fechados |
| 2 | Regime de alta (1h) | preço > EMA200 **e** EMA50 > EMA200 |
| 3 | Tendência de alta (15m) | EMA21 > EMA50 **e** preço > EMA50 **e** EMA50 não caindo |
| 4 | Volatilidade operável | ATR(14) do 5m entre 0,15% e 2,5% do preço; candle de 1m não pode ser > 4× ATR(1m) |
| 5 | Spread | ≤ limite configurado (padrão 0,15%) |
| 6 | Sem sobrecompra (5m) | RSI ≤ 72 e %B de Bollinger ≤ 1,0 |
| 7 | Risco/retorno líquido | ≥ mínimo (padrão 1,5) **depois de taxas e slippage** |

## 2. Pontuação (0–100) — entra só com pontuação ≥ mínimo (padrão 70)

| Componente | Pontos | Como ganha |
|---|---|---|
| Alinhamento de tendência | 20 | EMA9>EMA21>EMA50 no 5m (10, ou 5 se só EMA21>EMA50); EMA50 do 1h subindo (5); EMA21 do 15m subindo (5) |
| Pullback e localização | 20 | algum dos últimos 6 candles de 5m tocou EMA21/VWAP (10); preço acima do VWAP (5); %B entre 0,2 e 0,8 (5) |
| Momentum | 20 | histograma MACD subindo 2 candles (8) ou 1 (4); MACD acima do sinal (4); RSI 45–65 subindo (8) ou 40–70 (4) |
| Gatilho no 1m | 15 | fechamento acima da EMA9 (5); padrão de alta — engolfo, martelo ou fechamento forte (5); rompeu a máxima anterior (5) |
| Volume | 10 | volume do 5m ≥ 1,5× a média de 20 (10) ou ≥ 1,0× (5) |
| Espaço até a resistência | 15 | resistência a ≥ 2R (15) ou ≥ 1,5R (8); sem resistência mapeada (15) |

Suporte/resistência: topos e fundos (pivôs 3×3) dos gráficos de 15m e 1h agrupados em zonas de 0,25%.

## 3. Stop e alvo
- **Stop**: abaixo do menor fundo dos últimos 6 candles de 5m (− 0,1×ATR), limitado entre 1,0× e 2,0× ATR(5m).
- **Alvo**: 2,5× a distância do stop, reduzido para logo abaixo da resistência se ela estiver antes.
- Se o R:R líquido ficar abaixo do mínimo, **não entra**.

## 4. Gestão da posição (a cada atualização de preço)
1. Lucro de 1R → stop vai para o *break-even* (entrada + 2× taxa).
2. Lucro de 1,5R → stop móvel a 1×ATR abaixo da máxima alcançada.
3. Saídas: stop, alvo, tempo máximo (padrão 240 min) ou candle de 15m fechando abaixo da EMA50.
4. Stop executa no preço real disponível (bid). Se o preço "pular" o stop, a perda é maior — e isso é registrado.

## 5. Honestidade estatística
Esta estratégia **não tem lucratividade comprovada**. O backtest com dados reais (ver PUBLICAR_PELO_ANDROID.md)
calcula média por operação em R, intervalo de confiança 95% por bootstrap e só declara evidência com
≥ 100 operações **e** limite inferior do intervalo > 0.
