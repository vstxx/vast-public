import {
  BookOpen,
  Boxes,
  Briefcase,
  Camera,
  Code2,
  Dumbbell,
  FlaskConical,
  Gamepad2,
  Globe2,
  GraduationCap,
  Heart,
  Home,
  Music,
  Palette,
  Plane,
  Rocket,
  Shield,
  Sparkles,
  type LucideIcon
} from 'lucide-react'

export const WORKSPACE_ICON_OPTIONS: ReadonlyArray<{ name: string; label: string; icon: LucideIcon }> = [
  { name: 'Sparkles', label: 'Sparkles', icon: Sparkles },
  { name: 'Home', label: 'Home', icon: Home },
  { name: 'Briefcase', label: 'Work', icon: Briefcase },
  { name: 'GraduationCap', label: 'School', icon: GraduationCap },
  { name: 'BookOpen', label: 'Reading', icon: BookOpen },
  { name: 'FlaskConical', label: 'Research', icon: FlaskConical },
  { name: 'Code2', label: 'Code', icon: Code2 },
  { name: 'Boxes', label: 'Projects', icon: Boxes },
  { name: 'Gamepad2', label: 'Gaming', icon: Gamepad2 },
  { name: 'Plane', label: 'Travel', icon: Plane },
  { name: 'Globe2', label: 'Web', icon: Globe2 },
  { name: 'Rocket', label: 'Launch', icon: Rocket },
  { name: 'Palette', label: 'Creative', icon: Palette },
  { name: 'Camera', label: 'Photos', icon: Camera },
  { name: 'Music', label: 'Music', icon: Music },
  { name: 'Heart', label: 'Personal', icon: Heart },
  { name: 'Dumbbell', label: 'Fitness', icon: Dumbbell },
  { name: 'Shield', label: 'Private', icon: Shield }
]

const icons: Record<string, LucideIcon> = Object.fromEntries(
  WORKSPACE_ICON_OPTIONS.map((option) => [option.name, option.icon])
)

export function WorkspaceIcon({ name, className = 'h-4 w-4' }: { name: string; className?: string }): JSX.Element {
  const Icon = icons[name] ?? Sparkles
  return <Icon className={className} />
}
