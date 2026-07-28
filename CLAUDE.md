# Džiokeris — Project Instructions

## What this project is
A browser-based interactive card game trainer for the Lithuanian card game Džiokeris (similar to Rummy).
Goal: improve Simas's playing technique through practice with AI opponents and a coach system.

## Game rules — Variant 2 (implemented)

### Setup
- 1 deck: 52 cards + 2 jokers = 54 cards
- 3–5 players; each gets 7 cards
- One card turned face-up to start the discard pile; rest face-down as the draw pile

### Card values (points = bad)
- Ace: 11 points
- King, Queen, Jack: 10 points each
- Joker (uncombined): 25 points
- All others: face value (2=2, 3=3, … 10=10)

### Valid combinations
- **Run**: 3+ consecutive cards of the same suit (e.g., ♣2, ♣3, ♣4). Can extend to 7 cards.
- **Set**: 3 or 4 cards of the same rank (e.g., three Kings)
- Ace: can be low (A-2-3) or high (Q-K-A) but NOT both ends at once (K-A-2 is invalid)
- Joker substitutes any card

### Variant 2 turn flow
1. Draw one card (from draw pile or discard pile)
2. Optionally lay down combination(s) on the table, OR add cards to existing combinations on the table, OR rearrange/merge existing table combinations — even without having a combination yourself
3. Rules for table manipulation:
   - Cannot take a card from the table back into your hand
   - After all moves, only valid combinations may remain on the table (no loose cards)
4. Discard one card face-up to end your turn

### End of round
- The round ends when a player lays ALL their cards on the table and discards their last card (or has nothing to discard)
- After round ends, other players CANNOT lay more cards — count uncombined points immediately

### Scoring
- Each player counts their uncombined cards' point total
- Running total accumulates across rounds
- At 100+ points: player pays 1 candy to the pot; score resets to the next-highest player's score
- Special rule near 100: if your total is over 90, you cannot end the round unless your uncombined cards would keep you under 100
- Game ends when all players except one have reached 100+ points
- Last player under 100 wins all candies

### Variant 1 (not implemented — future)
- Combinations only laid at end of round, not during turns

## Stack
- Pure HTML + CSS + JavaScript, single file
- No dependencies, no build tools
- Output: `output/dziokeris.html`

## File layout
- `output/dziokeris.html` — the game
- `lessons.md` — corrections per session
