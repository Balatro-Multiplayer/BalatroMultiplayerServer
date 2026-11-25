import Image from 'next/image'
import Link from 'next/link'
import type { ReactNode } from 'react'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { createMetadata } from '@/lib/metadata'

export const metadata = createMetadata({
  title: 'FAQ',
  description:
    'Answers to common questions about setting up Balatro Multiplayer.',
  path: '/faq',
})

interface Faq {
  question: string
  answer: ReactNode
}

// Add new questions here. Each entry becomes one expandable item.
const DownloadLink = () => (
  <Link href='/download' className='font-semibold underline'>
    Download page
  </Link>
)

const FAQS: Faq[] = [
  {
    question: 'I installed everything manually and I can not queue Ranked',
    answer: (
      <p>
        You must use Balatro Essentials Toolkit (BET) or our r2modman fork that
        has the anti-cheat features to play Ranked. Both are on the{' '}
        <DownloadLink />.
      </p>
    ),
  },
  {
    question: 'I downloaded BET but the game launches vanilla',
    answer: <p>Restart your computer.</p>,
  },
  {
    question: 'I downloaded BET but I can not queue Ranked',
    answer: (
      <div className='space-y-3'>
        <p>
          You must be using a Ranked profile. Follow the guide below to make
          one. If you did everything correctly, a golden{' '}
          <strong>Verified</strong> tag will display at the top left.
        </p>
        <Image
          src='/images/faq/ranked-profile-guide.webp'
          alt='Creating a Ranked profile in BET: 1. click New Profile, 2. name it, 3. pick Multiplayer PvP, 4. pick Ranked, 5. click Create Profile'
          width={1058}
          height={837}
          className='w-full rounded-lg border'
        />
      </div>
    ),
  },
  {
    question:
      'I used BET before and I am on the latest version, but it says Multiplayer API is not on the index, that Lovely 0.9.0 is for Ranked and it needs 0.10.0, or I can not install WIMF',
    answer: (
      <p>
        The auto updater does not work for everyone. Redownload BET from the{' '}
        <DownloadLink />.
      </p>
    ),
  },
  {
    question:
      'I set everything up right but the mod keeps saying Steam is not open',
    answer: (
      <p>
        Either Steam is not open (it needs to be open, running 1.0), or you are
        on Linux and need your game installed on your home drive. See the pinned
        message in the <strong>bet-feedback</strong> channel in our Discord for
        more info.
      </p>
    ),
  },
  {
    question:
      'On a Ranked profile the game does not open and eventually says "failed to do handshake", but it launches fine on a Custom profile',
    answer: (
      <p>
        Launch BET in admin mode. To automate this, right click the BET exe,
        choose <strong>Properties</strong> then <strong>Compatibility</strong>,
        and check <strong>Run this program as an administrator</strong>.
      </p>
    ),
  },
]

export default function FaqPage() {
  return (
    <div className='mx-auto flex w-[calc(100%-1rem)] max-w-fd-container flex-1 flex-col py-8'>
      <div className='mb-10 text-center'>
        <h1 className='font-bold text-4xl tracking-tight'>FAQ</h1>
        <p className='mt-4 text-lg text-muted-foreground'>
          Common issues setting up Ranked 1.0
        </p>
      </div>

      <Accordion type='multiple' className='mx-auto w-full max-w-3xl'>
        {FAQS.map((faq) => (
          <AccordionItem key={faq.question} value={faq.question}>
            <AccordionTrigger className='text-base'>
              {faq.question}
            </AccordionTrigger>
            <AccordionContent className='text-muted-foreground'>
              {faq.answer}
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </div>
  )
}
