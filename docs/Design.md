# ECS Drive — Design System

## Visual Direction
Use the existing ECSHub website as the visual inspiration for overall tone, spacing, simplicity, educational context, and clean student-focused presentation. The current ECSHub describes itself as a structured study portal for B.Sc. ECS students. citeturn0view0

ECS Drive should feel like the natural file-storage companion to ECSHub:
- clean
- modern
- academic
- friendly
- lightweight
- mobile-first
- not overly corporate

## Brand
Name: ECS Drive

Suggested tagline:
"Your College Files. One Place."

## Color Direction
Start with a restrained blue/indigo academic palette inspired by ECSHub's clean digital-education feel:
- Primary: deep indigo/blue
- Secondary: bright blue
- Background: very light cool gray/white
- Surface: white
- Text: dark slate
- Muted text: slate gray
- Success: green
- Warning: amber
- Error: red

Do not hard-code colors throughout the application. Define CSS variables/tokens in one place.

## Typography
- Prefer Inter or another clean modern sans-serif available through a reliable web font.
- Use strong hierarchy:
  - H1: 32–40px desktop, 28–34px mobile
  - H2: 24–30px
  - Body: 15–17px
  - Small/meta: 13–14px
- Keep line height comfortable and avoid dense blocks.

## Layout
- Max content width around 1100–1200px.
- Generous whitespace.
- Rounded cards, but not excessively rounded.
- Clear primary CTA.
- Folder cards should be easy to scan.
- Use icons consistently.

## Main Screens
1. Landing/dashboard
2. Folder browser
3. Create folder
4. Password unlock
5. File list
6. Upload state/progress
7. Folder management
8. Error/empty states

## Components
- Header
- Search bar
- Folder card
- File row/card
- Storage meter
- Create-folder modal
- Password modal
- Upload dropzone
- Toast/alert
- Confirmation dialog

## Responsive Rules
- Mobile is a first-class experience.
- Folder/file controls must be touch-friendly.
- Avoid horizontal scrolling.
- On small screens, use stacked layouts.

## Accessibility
- Keyboard navigation.
- Visible focus states.
- Semantic HTML.
- Labels for form controls.
- Do not use color as the only error indicator.

## Branding Rule
Use ECSHub as inspiration, not as a source to copy. ECS Drive must have its own logo/wordmark and original UI implementation.
