import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { ProfileForm } from './ranked-mods-types'

export function ProfileFormDialog({
  open,
  mode,
  form,
  isPending,
  onFormChange,
  onSave,
  onClose,
}: {
  open: boolean
  mode: 'create' | 'edit'
  form: ProfileForm
  isPending: boolean
  onFormChange: (f: ProfileForm) => void
  onSave: () => void
  onClose: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='sm:max-w-[500px]'>
        <DialogHeader>
          <DialogTitle>
            {mode === 'create' ? 'New preset profile' : 'Edit preset profile'}
          </DialogTitle>
          <DialogDescription>
            A preset the launcher offers when a player creates a profile.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            onSave()
          }}
          className='space-y-4'
        >
          <div className='space-y-2'>
            <Label htmlFor='profile-name'>Name</Label>
            <Input
              id='profile-name'
              value={form.name}
              onChange={(e) => onFormChange({ ...form, name: e.target.value })}
              required
            />
          </div>
          <div className='space-y-2'>
            <Label htmlFor='profile-slug'>Slug</Label>
            <Input
              id='profile-slug'
              value={form.slug}
              placeholder='ranked-standard'
              onChange={(e) => onFormChange({ ...form, slug: e.target.value })}
              required
            />
            <p className='text-muted-foreground text-xs'>
              Lowercase letters, numbers and dashes. The launcher looks the
              preset up by this, so changing it can break links to it.
            </p>
          </div>
          <div className='space-y-2'>
            <Label htmlFor='profile-description'>Description</Label>
            <Input
              id='profile-description'
              value={form.description}
              onChange={(e) =>
                onFormChange({ ...form, description: e.target.value })
              }
            />
          </div>
          <DialogFooter>
            <Button type='button' variant='outline' onClick={onClose}>
              Cancel
            </Button>
            <Button
              type='submit'
              disabled={isPending || !form.name || !form.slug}
            >
              {isPending ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
