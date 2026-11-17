# Risco e capital — e a verdade sobre os R$30

## Proteções implementadas (todas testadas)

| Proteção | Padrão | Faixa permitida (trava no código) |
|---|---|---|
| Risco máximo por operação (perda no stop, com taxas) | 2% | 0,1–3% |
| Limite de perda diária (realizada + aberta) → bloqueia entradas até o dia seguinte | 6% | 0,5–10% |
| Operações simultâneas | 1 | 1–3 |
| Exposição total | 95% | 10–95% |
| Spread máximo | 0,15% | 0,01–0,5% |
| Pontuação mínima | 70 | 60–95 |
| R:R líquido mínimo | 1,5 | 1,2–5 |
| Perdas seguidas até pausar | 3 (pausa 120 min) | 1–10 |
| Intervalo após sair de um ativo | 15 min | 0–240 |
| Dados desatualizados (sem entrada) | 15 s | 3–60 |
| Circuit breaker (candle de 1m anormal) | 3% → bloqueia o ativo 30 min | 1–10% |
| Valor de 1 passo de lote vs. patrimônio | 5% | 1–25% |

Também: ordem duplicada impedida (ID único por candle e por saída + trava "ordem em andamento"),
3 falhas de execução em 5 min → pausa de 15 min, reinício seguro, emergência que vende tudo.
**Proibido no código:** martingale, aumento de posição perdedora, aumento de risco após perda.
O tamanho da posição é sempre calculado do zero a partir do patrimônio atual.

## O problema real dos R$30

1. **Valor mínimo de ordem da Binance**: os pares em USDT costumam exigir cerca de 5 USDT
   (o robô lê o valor exato da Binance). R$30 ≈ 5,5 USDT (dependendo do dólar).
   Ou seja, **uma única operação usa ~95% do capital**.
2. **A saída também precisa ser válida**: se o preço cai até o stop, a posição precisa continuar
   acima do mínimo para poder ser vendida. O robô só entra se isso for verdade.
3. **Poeira (dust)**: na Binance a taxa da compra sai da moeda comprada. Como a quantidade vendida é
   arredondada para o lote mínimo, quase 1 passo de lote fica "preso". No BTC isso vale ~1 USDT
   (≈17% de R$30). O robô:
   - recusa ativos cujo lote vale mais que 5% do patrimônio (BTC, ETH, BNB com R$30);
   - vende o saldo inteiro na saída (reaproveita a poeira de operações anteriores);
   - inclui a poeira no resultado da operação, para o lucro registrado bater com o patrimônio.
4. **Taxas**: 0,1% na compra + 0,1% na venda, além do spread. Movimentos pequenos não pagam o custo;
   por isso o filtro de R:R é calculado **depois** das taxas.

### O que isso significa na prática
Em simulação com R$30, **a maioria dos sinais é recusada por capital** — o robô informa exatamente
o motivo no "Cérebro do robô" e fica sem operar. Isso é o comportamento correto, não um defeito.
Num teste com dados sintéticos, R$30 gerou 193 sinais e 0 operações (todos recusados por capital);
o mesmo teste com R$100 executou 9 operações normalmente.

**Opções** (você decide; nada foi alterado sem autorização):
- manter R$30 e aceitar poucas ou nenhuma operação;
- aumentar o capital simulado (`INITIAL_CAPITAL_BRL`) para ver como o robô se comporta com R$60–R$100;
- monitorar ativos de lote barato (ex.: ADA, DOGE, TRX), alterando `SYMBOLS`.

Lembre também que a hospedagem (~US$5/mês) custa aproximadamente o mesmo que o capital.
